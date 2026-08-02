// ffmpeg → live HLS → mirror the rolling window into a Hyperdrive.
//
// v0.1 uses MPEG-TS segments (index.m3u8 + segN.ts): simple, universally playable, no
// separate init file to track.
//
// S15a: typed inputs (test / file / pull URL / rtmp / srt / udp push listeners) and
// per-channel transcode settings (encoder incl. GPU, resolution/fps/bitrate/preset).
// Everything in this file is a pure argument builder (covered by tools/args-test.mjs);
// input/transcode objects are validated in channel.js before they reach us, and
// encoder/protocol AVAILABILITY is checked against capabilities.js at start().

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
// Whole-namespace core GC lives in @aliran/core (the panel reclaims stray cores with the
// same sweep, and cannot import from this workspace — separate image).
import { DISCOVERY_HEX_RE } from '@aliran/core/store-gc.js'

export const TRANSCODE_DEFAULTS = {
  encoder: 'libx264',
  resolution: 'source',
  fps: 'source',
  videoBitrateKbps: null, // null = encoder default rate control (x264 CRF)
  audioBitrateKbps: 128,
  preset: 'fast',
  // 'auto' = let the host decide (channel.js resolves it against the capability
  // probe before the args are built); true/false force it. See hwDecodeArgs.
  hwDecode: 'auto',
  gpu: null, // null = ffmpeg's default device; N pins decode+encode to that GPU
  audioCodec: 'aac',
  audioSampleRate: 48000,
  audioChannels: null, // null = keep the source's layout
  // 'first' reproduces ffmpeg's default stream selection — ONE audio track, whichever it
  // judges best. 'all' keeps every audio track as its own PID in the same MPEG-TS
  // segments, which is what a multi-language IPTV source needs.
  audioTracks: 'first',
  logo: null, // { path, corner, marginPx, heightPx } — see logoFilters
  subtitles: null, // { path } — burn an external .srt/.ass into the picture
  // --- 24/7 stability. Each answers a failure that only appears on a long-running live
  // channel, which is exactly why none of them are ffmpeg defaults.
  fpsMode: 'source', // 'cfr' forces a constant frame rate
  maxMuxQueue: null, // packets — guards the "Too many packets buffered" abort
  audioSync: false, // aresample=async — corrects audio drifting away from video
  // --- timestamp base, alongside ingestTuning's genpts/igndts.
  avoidNegativeTs: false,
  copyTs: false
}

// Named presets, plus free-form '<W>x<H>' handled by parseResolution.
const RES_HEIGHT = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }
export const CUSTOM_RES_RE = /^(\d{2,5})x(\d{2,5})$/
export const LOGO_CORNERS = new Set(['tl', 'tr', 'bl', 'br'])
export const AUDIO_CODECS = new Set(['aac', 'mp2', 'opus', 'copy'])
export const AUDIO_SAMPLE_RATES = new Set([44100, 48000])
export const AUDIO_CHANNELS = new Set([1, 2, 6])

// → { w, h } | { h } | null. A named preset scales by HEIGHT with the aspect preserved
// (-2 = nearest even width, which every H.264 encoder requires); an explicit WxH is taken
// literally, because an operator who typed both numbers means both numbers.
export function parseResolution (resolution) {
  if (!resolution || resolution === 'source') return null
  const preset = RES_HEIGHT[resolution]
  if (preset) return { h: preset }
  const m = CUSTOM_RES_RE.exec(String(resolution))
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null
}

// Encoders that take the NVIDIA path (-gpu, CUVID decode, scale_cuda, -forced-idr).
// hevc_nvenc behaves identically to h264_nvenc for all of it — same preset scale, same
// forced-IDR requirement, same CUDA surface handling — so it belongs to the same family.
export const NVENC_ENCODERS = new Set(['h264_nvenc', 'hevc_nvenc'])

// Software encoders: compiled in means usable, and both want the same low-latency tuning
// and an explicit 8-bit pixel format (x265 otherwise happily emits 10-bit from a 10-bit
// source, which is correct but not what a compatibility-first live channel wants).
export const SOFTWARE_ENCODERS = new Set(['libx264', 'libx265'])

// HEVC output, whoever produced it. These need -tag:v hvc1: ffmpeg's HLS muxer says so
// itself ("Stream HEVC is not hvc1, you should use tag:v hvc1 to set it"), and without the
// tag a range of players refuse HEVC in HLS outright. Harmless on MPEG-TS, required the
// moment anything downstream repackages to fMP4 — and a silent no-play on a viewer's device
// is the most expensive kind of bug to chase.
export const HEVC_ENCODERS = new Set(['hevc_nvenc', 'libx265'])

// fast/balanced/quality → per-encoder speed/quality flag. vaapi has no preset
// concept (rate control only); amf uses -quality and is the least battle-tested
// of the four hw paths (surface as EXPERIMENTAL in the UI).
const PRESET_FLAGS = {
  libx264: { flag: '-preset', fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  // x265 is far slower than x264 at the same named preset, so 'quality' stops at 'slow'
  // rather than reaching for anything beyond it — a live encoder that cannot keep up with
  // realtime is not higher quality, it is a stalled channel.
  libx265: { flag: '-preset', fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  h264_nvenc: { flag: '-preset', fast: 'p2', balanced: 'p4', quality: 'p6' },
  hevc_nvenc: { flag: '-preset', fast: 'p2', balanced: 'p4', quality: 'p6' },
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

// Let ffmpeg's HTTP demuxer heal a dropped connection ITSELF instead of exiting and
// leaving the S15b watchdog to respawn the process. That distinction matters a lot on
// flaky IPTV: a respawn restarts ffmpeg's `seg%d` counter from 0, which strands the
// previous run's high-numbered segments (the orphan that pinned blob reclaim and caused
// the 2026-07-15 disk leak) and puts a visible gap in the feed. An internal reconnect
// keeps the same process, the same segment sequence, and the same feed.
//   reconnect_streamed         — REQUIRED for live: without it only seekable inputs retry
//   reconnect_on_network_error — retry a mid-stream socket error, not just EOF
//   reconnect_delay_max 5      — cap the backoff; the watchdog is still the outer net
// Verified present in the container's ffmpeg 5.1.9 before shipping — an unknown input
// option makes ffmpeg exit immediately, which would turn every channel into a crash loop.
// (This dev box runs 8.1.2, and test:args is pure-args, so it cannot catch that skew.)
const HTTP_RECONNECT = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5']

// Only these get -re. A VOD file served over http genuinely needs realtime pacing;
// anything else on http(s) is assumed LIVE (see the pull branch for why that default).
// -reconnect_at_eof is deliberately NOT applied to these: for a real file, EOF means the
// file ended, and retrying there would loop forever.
const VOD_FILE_RE = /\.(mp4|m4v|mkv|mov|avi|webm|flv|mpg|mpeg|wmv)($|\?)/i

export function urlScheme (url) {
  const m = String(url).match(/^([a-z][a-z0-9+.-]*):\/\//i)
  return m ? m[1].toLowerCase() : null
}

// Input half of the command line (up to and including -i). -re paces file-backed
// sources to realtime; live sources (push listeners, rtsp/rtmp/srt/udp pulls and
// live HLS playlists) pace themselves — -re on those starves the reader and adds
// drift, so it is applied ONLY to test/file and plain-http VOD pulls.
// HTTP(S)-ONLY source options. These are AVOptions of the http protocol, so emitting them
// for a udp/srt/rtmp input makes ffmpeg fail on an unrecognised option — which is why they
// live inside the http branch rather than alongside the scheme-agnostic ingest tuning.
//   user_agent  — many providers vary or gate on it; the ffmpeg default is a giveaway.
//   headers     — auth tokens, Referer, cookies. MUST end CRLF or ffmpeg mis-parses it.
//   rw_timeout  — fail a hung socket fast instead of waiting on the watchdog's stall
//                 detector, which only fires after the live edge has been frozen ~20 s.
function httpSourceArgs (tuning) {
  if (!tuning) return []
  const out = []
  if (tuning.userAgent) out.push('-user_agent', tuning.userAgent)
  if (tuning.headers) out.push('-headers', tuning.headers)
  if (tuning.rwTimeoutMs != null) out.push('-rw_timeout', String(tuning.rwTimeoutMs * 1000)) // µs
  return out
}

export function inputArgs (input, ingestTuning = null) {
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
      // Encrypted DASH the operator already holds the key for (CENC / ClearKey). This is
      // an option of the DASH demuxer, so it has to precede -i like any other input option.
      // ⚠ It decrypts with a key you SUPPLY. It is not a DRM client: Widevine and
      // PlayReady need a licence-server handshake and a CDM, neither of which ffmpeg has.
      const cenc = t.cencKey ? ['-cenc_decryption_key', t.cencKey] : []
      if (scheme === 'http' || scheme === 'https') {
        const HTTP = [...httpSourceArgs(ingestTuning), ...HTTP_RECONNECT]
        // -allowed_extensions ALL lets the HLS demuxer accept SSAI / ad-beacon segment URLs
        // that don't end in .ts (Amagi/DistroTV and many FAST channels) — without it ffmpeg
        // rejects the playlist ("not in allowed_segment_extensions"). It only RELAXES a filter,
        // so it's harmless for plain .ts feeds, and the operator already trusts the pull URL.
        if (/\.m3u8($|\?)/i.test(t.url)) return [...HTTP, ...cenc, '-allowed_extensions', 'ALL', '-i', t.url]
        // A DASH manifest is live-by-default like the HLS one above: no -re, and it is the
        // only place a CENC key is any use.
        if (/\.mpd($|\?)/i.test(t.url)) return [...HTTP, ...cenc, '-i', t.url]
        // ⚠ LIVE IS THE DEFAULT for an unknown http(s) pull, and -re is now opt-IN by file
        // extension. The old rule was ".m3u8 = live, everything else = a VOD file needing
        // realtime pacing" — false for raw mpegts over http, which is what most IPTV
        // actually serves (`http://host:81/CHANNEL/mpegts?token=…`, no extension at all).
        // All 69 production channels took the -re branch. ffmpeg's own docs say -re
        // "should not be used with actual grab devices or live input streams": it throttles
        // the reader to 1x, so after any jitter ffmpeg cannot catch up, the server-side
        // buffer backs up, and many IPTV servers drop a slow client — a self-inflicted
        // share of the restarts. Guessing "live" for an unknown URL is also the safer
        // error: a live source read without -re is correct, whereas a live source read
        // WITH -re degrades continuously.
        if (VOD_FILE_RE.test(t.url)) return [...HTTP, ...cenc, '-re', '-i', t.url]
        return [...HTTP, ...cenc, '-reconnect_at_eof', '1', '-i', t.url]
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

// CUVID decode straight into GPU memory, so the whole chain (decode → scale → encode)
// stays on the card and the CPU only demuxes and muxes. Measured on a 2x RTX 4090 box,
// 1080p30 → 720p/3000k: 1.6 CPU-seconds per 30 s of content vs 12.9 for CPU-decode+nvenc
// and 25.0 for libx264 veryfast — ~8x less CPU than the path this replaces.
//
// INPUT options, so they must precede the -i they apply to.
//
// Deliberately NOT applied when:
//   - the encoder is not nvenc — a CPU encoder would need an explicit hwdownload, and
//     `copy` decodes nothing at all.
//   - the input is `test` — lavfi synthesises raw frames, there is no bitstream to decode.
//   - hwDecode is 'auto'/false — 'auto' is resolved to a real boolean by channel.js
//     against the capability probe; an unresolved 'auto' reaching here means "off", so
//     the pure builder never depends on host state it cannot see.
//
// ⚠ `-hwaccel cuda` does NOT fail loudly on a codec CUVID cannot handle (10-bit H.264,
// say): ffmpeg silently falls back to the SOFTWARE decoder and then the scale_cuda filter
// below dies on CPU frames with "Impossible to convert between the formats" / "Function
// not implemented", exit 218. That is a per-SOURCE failure the capability probe cannot
// predict, so channel.js watches for that signature and respawns without hw decode.
export function hwDecodeArgs (transcode, input) {
  const t = { ...TRANSCODE_DEFAULTS, ...(transcode || {}) }
  if (t.hwDecode !== true) return []
  if (!NVENC_ENCODERS.has(t.encoder)) return []
  const kind = (input && input.kind) || (typeof input === 'string' ? upgradeInputString(input).kind : null)
  if (kind === 'test') return []
  const out = ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']
  if (t.gpu != null) out.push('-hwaccel_device', String(t.gpu))
  return out
}

// Is this transcode spec actually going to decode on the GPU? encodeArgs needs to know,
// because the filter and pixel-format rules differ between GPU and CPU frames.
function cudaFrames (t, input) {
  return hwDecodeArgs(t, input).length > 0
}

// ffmpeg stderr that means "this SOURCE cannot ride the CUDA path" — as opposed to "this
// HOST has no CUDA", which the capability probe already caught at start(). Every line here
// was observed on a real 2x RTX 4090 box feeding a High 10 source through -hwaccel cuda:
// CUVID declines the profile, ffmpeg silently swaps in the software decoder, and the
// mismatch surfaces at the filter graph rather than at the decoder. The channel watchdog
// matches these to respawn once on the CPU path instead of retrying a doomed config
// forever (see channel.js _spawnFfmpeg).
export const HW_DECODE_FAIL_RE = new RegExp([
  'impossible to convert between the formats', // scale_cuda handed CPU frames
  'failed to inject frame into filter network',
  'function not implemented', // the errno the above collapses into
  'failed setup for format cuda',
  'no decoder surfaces left', // CUVID surface pool exhausted
  'hwaccel initialisation returned error',
  'cannot load libcuda'
].join('|'), 'i')

// How many `-i` the MAIN source contributes. Everything that references a stream by index
// depends on this, and it is not always 1: the `test` input is TWO inputs (an lavfi video
// pattern plus an lavfi tone), so a logo added after it is input 2 and the tone is input 1.
// Getting this wrong is not a subtle failure — ffmpeg refuses the whole graph with
// "Stream specifier ':v' in filtergraph description ... matches no streams" and the channel
// never starts. (Found exactly that way: unit tests all used single-input sources.)
export function mainInputCount (input) {
  const t = upgradeInputString(input)
  return t && t.kind === 'test' ? 2 : 1
}

// Which input carries the source audio. For `test` the tone is its own input; for every
// other kind the audio shares input 0 with the video.
function audioInputIndex (input) {
  return mainInputCount(input) === 2 ? 1 : 0
}

// ffmpeg filter-graph escaping. A path reaches the graph through two parsers, so the
// characters that terminate a filter ARGUMENT (:) and the graph itself (' and \) all have
// to survive both. Windows paths hit every one of them at once ("C:\subs\a.srt").
function escFilterPath (p) {
  return String(p).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')
}

// Corner + margin → overlay x/y. W,H are the MAIN frame and w,h the overlay, so the
// right/bottom anchors keep working whatever raster the source turns out to be — the
// alternative (fixed pixel offsets) silently misplaces the logo when a source changes size.
function overlayXY (corner, marginPx) {
  const m = Number.isFinite(marginPx) ? marginPx : 20
  if (corner === 'tl') return `x=${m}:y=${m}`
  if (corner === 'bl') return `x=${m}:y=H-h-${m}`
  if (corner === 'br') return `x=W-w-${m}:y=H-h-${m}`
  return `x=W-w-${m}:y=${m}` // 'tr' — the conventional bug/DOG position
}

// The video filter chain. Returns EITHER a simple `-vf` string or a `-filter_complex`
// graph ending in [vout]; a logo forces the latter because it is a second input.
//
// The rule that drives everything here: subtitles (libass) and alpha blending are
// CPU-ONLY filters. On the GPU path they need an explicit hwdownload → filter →
// hwupload_cuda round trip, and getting that wrong does not fail loudly — it fails with
// "Impossible to convert between the formats", the same opaque error the hw-decode
// fallback exists for. Measured cost of the round trip on a 4090 (1080p→720p, 6 s):
// 1.34 CPU-s against a 0.69 baseline, still well under the 2.92 of decoding on the CPU.
//
// ⚠ KNOWN LIMIT — a LOOPING file source plus this round trip dies at the loop point.
// `file` inputs carry -stream_loop -1, and when the file wraps ffmpeg reinitialises the
// filter graph; the CUDA upload does not survive that and the process exits with
// "Impossible to convert between the formats supported by the filter
// 'Parsed_hwupload_cuda_N'". Measured: three concurrent channels each held exact 2.000 s
// segments for 28 s and then all failed together at the 30 s loop boundary.
// It self-heals rather than crash-looping, because that string is one of the signatures in
// HW_DECODE_FAIL_RE: the watchdog marks the run, respawns without GPU decode, and the CPU
// chain (no hwupload) loops indefinitely. Cost is one respawn blip on the first wrap.
// Live sources — pull and the push listeners — never wrap, so they never hit this at all.
//
// ⚠ overlay_cuda is NOT used, deliberately. It looks like the obvious way to composite a
// logo without leaving the card, and it is documented as such — but on ffmpeg 6.1.1 with
// driver 580.159.03 it SEGFAULTS ffmpeg in every configuration tried: opaque and
// transparent logo, looped and single-shot input, literal and expression anchors. A
// crashing filter in a live channel is a respawn loop, not a slow channel. It also only
// accepts nv12, which has no alpha, so even working it would render a transparent PNG as
// a solid box. The CPU composite below is one code path, blends correctly, and was
// measured at 1.34 CPU-s against a 0.69 baseline — still far under the 2.92 of decoding
// on the CPU. If a future ffmpeg fixes the crash this is where the fast path would go.
export function videoChain (transcode, onGpu, input = null) {
  const t = { ...TRANSCODE_DEFAULTS, ...(transcode || {}) }
  const logoIdx = mainInputCount(input) // the logo is appended AFTER the source's inputs
  const res = parseResolution(t.resolution)
  const scale = res
    ? (onGpu ? `scale_cuda=${res.w ?? -2}:${res.h}` : `scale=${res.w ?? -2}:${res.h}`)
    : null
  const subs = t.subtitles && t.subtitles.path
    ? `subtitles=filename='${escFilterPath(t.subtitles.path)}'`
    : null
  const logo = t.logo && t.logo.path ? t.logo : null

  if (!logo) {
    const parts = []
    if (scale) parts.push(scale)
    if (subs) {
      // The exact round trip verified against ffmpeg 6.1.1 on an RTX 4090.
      if (onGpu) parts.push('hwdownload', 'format=nv12', subs, 'format=yuv420p', 'hwupload_cuda')
      else parts.push(subs)
    }
    if (t.encoder === 'h264_vaapi') parts.push('format=nv12', 'hwupload') // vaapi encodes GPU surfaces only
    return { vf: parts.length ? parts.join(',') : null, complex: null }
  }

  const prep = []
  if (logo.heightPx) prep.push(`scale=-1:${logo.heightPx}`)
  const pos = overlayXY(logo.corner, logo.marginPx)

  // rgba unconditionally: it carries alpha when the image has it and costs nothing when it
  // does not, so there is no format decision for an operator to get wrong.
  const base = []
  if (scale) base.push(scale)
  if (onGpu) base.push('hwdownload', 'format=nv12')
  if (subs) base.push(subs)
  // Whatever the encoder needs to receive, applied AFTER the composite: cuda surfaces for
  // nvenc, a vaapi surface for h264_vaapi (which, like nvenc, cannot take system memory).
  const tail = onGpu
    ? ',format=yuv420p,hwupload_cuda'
    : (t.encoder === 'h264_vaapi' ? ',format=nv12,hwupload' : '')
  return {
    vf: null,
    complex: `[${logoIdx}:v]${[...prep, 'format=rgba'].join(',')}[lg];` +
      `[0:v]${base.length ? base.join(',') : 'null'}[bg];[bg][lg]overlay=${pos}${tail}[vout]`
  }
}

// The logo is an EXTRA ffmpeg input appended after the source's own. Its stream index is
// therefore mainInputCount(input), not a constant 1 — see videoChain.
export function logoInputArgs (transcode) {
  const t = { ...TRANSCODE_DEFAULTS, ...(transcode || {}) }
  return t.logo && t.logo.path ? ['-i', t.logo.path] : []
}

// Output-side codec options. `transcode` may be null/partial; defaults preserve
// pre-S15a behavior except -g 60 → -force_key_frames, which aligns keyframes to
// segment boundaries for every encoder regardless of source fps.
// `input` is only consulted to tell GPU frames from CPU frames (see hwDecodeArgs);
// omitting it assumes a real bitstream, which is what every non-test channel is.
export function encodeArgs (transcode, hls, input = null) {
  const t = { ...TRANSCODE_DEFAULTS, ...(transcode || {}) }
  const onGpu = cudaFrames(t, input)
  const chain = videoChain(t, onGpu, input)
  const out = []
  // `test` splits video and audio across two inputs, so the audio does not live on input 0.
  const aIdx = audioInputIndex(input)

  // Stream selection. ffmpeg's DEFAULT is one video + one audio, which is what a channel
  // with neither a logo nor extra audio tracks wants — so we stay silent in that case and
  // the argument list is unchanged from before this feature existed. Anything else has to
  // be mapped explicitly: a filter_complex output is not auto-selected, and extra audio
  // tracks are not either. Every audio map is optional ('?') because a video-only source
  // is legitimate and must not turn into a hard ffmpeg failure.
  const allAudio = t.audioTracks === 'all'
  if (chain.complex) {
    out.push('-filter_complex', chain.complex, '-map', '[vout]')
    out.push('-map', allAudio ? `${aIdx}:a?` : `${aIdx}:a:0?`)
  } else if (allAudio) {
    out.push('-map', '0:v:0', '-map', `${aIdx}:a?`)
  }

  if (t.encoder === 'copy') {
    // Passthrough: segment cuts land on the SOURCE's keyframes — the publisher
    // must send a keyframe every hls.time seconds (OBS: keyframe interval).
    out.push('-c:v', 'copy')
  } else {
    out.push('-c:v', t.encoder)
    const preset = PRESET_FLAGS[t.encoder]
    if (preset) out.push(preset.flag, preset[t.preset])
    if (SOFTWARE_ENCODERS.has(t.encoder)) out.push('-tune', 'zerolatency', '-pix_fmt', 'yuv420p')
    if (NVENC_ENCODERS.has(t.encoder)) {
      out.push('-tune', 'll')
      // ⚠ LOAD-BEARING: nvenc silently IGNORES -force_key_frames without this, so the HLS
      // muxer finds no keyframe to cut on. Measured on ffmpeg 6.1.1 / RTX 4090 with the
      // args main ships today: 13 s of input came out as ONE 12.9 s segment instead of
      // seven 2 s ones. `-tune ll` is what makes it fatal rather than merely wrong — low
      // latency means no periodic IDR, so the only keyframe is the first and the segment
      // grows without bound: the live window never rolls, delete_segments never trims, and
      // a late joiner has nothing playable to start from. (Dropping the tune is not a fix
      // — you just get nvenc's own 250-frame GOP, i.e. 8 s segments at 30 fps.)
      // -forced-idr is preferred over -g N because it keeps the keyframe cadence tied to
      // hls.time without having to know the source fps, which is the whole reason this
      // builder uses -force_key_frames instead of -g in the first place.
      out.push('-forced-idr', '1')
      if (t.gpu != null) out.push('-gpu', String(t.gpu))
      // H.264 NVENC is 8-bit ONLY: without this a High 10 source arrives as yuv420p10le
      // and nvenc refuses it with the thoroughly misleading "No capable devices found",
      // which reads like a missing GPU rather than a pixel format (measured: the shipped
      // args fail on any 10-bit source today). hevc_nvenc COULD emit Main10, but a live
      // channel is pinned to 8-bit deliberately — 10-bit narrows the set of viewer devices
      // that can decode it, and the point of transcoding here is reach, not mastering.
      // Only on the CPU-decode path — with CUDA frames the conversion is scale_cuda's job
      // and -pix_fmt would force a pointless GPU→CPU download.
      if (!onGpu) out.push('-pix_fmt', 'yuv420p')
    }
    if (HEVC_ENCODERS.has(t.encoder)) out.push('-tag:v', 'hvc1')
    out.push('-force_key_frames', `expr:gte(t,n_forced*${hls.time})`)
    if (t.videoBitrateKbps != null) {
      out.push('-b:v', `${t.videoBitrateKbps}k`, '-maxrate', `${t.videoBitrateKbps}k`, '-bufsize', `${t.videoBitrateKbps * 2}k`)
    }
    if (t.fps !== 'source') out.push('-r', String(t.fps))
    // A VARIABLE-frame-rate source segments badly: the muxer cuts on wall-clock but the
    // frames arrive unevenly, so EXTINF durations wander and players stutter at the joins.
    // HLS wants CFR. Not the default because forcing it on an already-constant source only
    // adds frame duplication/drops for nothing. (-fps_mode replaced -vsync in ffmpeg 5.0;
    // the production container runs 5.1.9, so it is safe here.)
    if (t.fpsMode === 'cfr') out.push('-fps_mode', 'cfr')
    // "Too many packets buffered for output stream" is a hard ABORT, not a warning, and it
    // is reached whenever one stream runs ahead of another — a long GOP, a sparse audio
    // track, an upstream hiccup. The default queue is small; raising it turns a dead
    // channel into a brief memory bump.
    if (t.maxMuxQueue != null) out.push('-max_muxing_queue_size', String(t.maxMuxQueue))
    // Timestamp base. avoid_negative_ts make_zero rebases a stream that starts negative
    // (common after genpts); copyts preserves the SOURCE timeline instead, and pairs with
    // start_at_zero so the first segment still begins at 0 rather than at an arbitrary
    // upstream offset. They are opposite strategies — validation refuses both at once.
    if (t.avoidNegativeTs) out.push('-avoid_negative_ts', 'make_zero')
    if (t.copyTs) out.push('-copyts', '-start_at_zero')
    // Scaling, subtitle burn-in and the hardware round trips all live in videoChain; a
    // logo turns the chain into a -filter_complex that was already emitted above.
    if (chain.vf) out.push('-vf', chain.vf)
  }

  if (t.audioCodec === 'copy') {
    // Passthrough audio: no re-encode, so bitrate/rate/channels are all meaningless here.
    out.push('-c:a', 'copy')
  } else {
    out.push('-c:a', t.audioCodec, '-ar', String(t.audioSampleRate), '-b:a', `${t.audioBitrateKbps}k`)
    if (t.audioChannels != null) out.push('-ac', String(t.audioChannels))
    // Audio DRIFT is the classic 24/7 live failure: a source whose audio clock runs a
    // fraction off video walks visibly out of sync over hours, and nothing in the pipeline
    // notices because every segment is individually fine. aresample=async stretches or
    // pads audio to keep it pinned to the video timeline. It re-encodes audio by
    // definition, so `copy` cannot use it — validation refuses that combination.
    if (t.audioSync) out.push('-af', 'aresample=async=1:first_pts=0')
  }
  return out
}

// `discont_start` marks the first segment of EVERY spawn with #EXT-X-DISCONTINUITY. This is
// not slate-specific: a respawn restarts ffmpeg, and a restarted ffmpeg resets its output
// clock, so with `append_list` the new segments land after the old ones with a timestamp
// that jumps BACKWARD — measured at ~6034 s on a channel up 1.7 h, and it scales with
// uptime. That is the unmarked "visible gap" every watchdog respawn has always produced
// (~1.45 per channel per hour on the production fleet). The tag tells the player to reset
// its timestamp mapping instead of trying to reconcile a timeline that ran backwards, and
// it is the ONLY thing that makes a slate's codec/resolution change legal mid-playlist.
// Adding a marker can never make a playlist worse than an unmarked discontinuity.
export function hlsMuxArgs (hls, outDir) {
  return [
    '-f', 'hls',
    '-hls_time', String(hls.time),
    '-hls_list_size', String(hls.listSize),
    // program_date_time: EXT-X-PROGRAM-DATE-TIME per segment. ExoPlayer (media3)
    // computes its LIVE OFFSET against these wall-clock tags — without them the
    // Android apps' targetOffsetMs silently no-ops and the player sits at the
    // live edge with ~no churn headroom (measured on the S22: froze ~5 s after
    // a source kill instead of riding the ~10 s offset; hls.js is unaffected —
    // it counts segments). Costs ~40 bytes per playlist line.
    '-hls_flags', 'delete_segments+append_list+omit_endlist+discont_start+program_date_time',
    '-hls_segment_filename', path.join(outDir, 'seg%d.ts'),
    path.join(outDir, 'index.m3u8')
  ]
}

// --- rolling live thumbnail ------------------------------------------------------------
// One JPEG of "what is on screen right now", refreshed every `intervalSeconds`, written
// into the SAME ffmpeg scratch dir as the segments. That placement is the whole design:
// mirrorDirToDrive already treats a CHANGED file as "put the new bytes, then clearBlob the
// superseded ones" (it is what keeps index.m3u8 from accumulating a version per segment),
// so a thumbnail that overwrites itself in place inherits bounded storage for free — no
// new drive, no new reclaim path, no append-only archive growing 2.5 GB/day fleet-wide.
//
// ⚠ It DOES cost the safety-net sweep some slack. reclaimExpiredBlobs() bulk-frees
// everything below the lowest blockOffset still referenced by a live entry, and between
// refreshes thumb.jpg IS that lowest entry — so the watermark now lags by up to one
// refresh interval's worth of segment blocks. Not a leak: the per-entry clears in
// mirrorDirToDrive free each rotated segment precisely as it leaves the window, and the
// sweep is only the backstop. Worth knowing when reading a mid-interval block count.
export const THUMB_DEFAULTS = {
  intervalSeconds: 30,
  width: 320, // -2 height keeps the aspect and lands on an even raster
  quality: 7 // mjpeg qscale 2-31, lower = better; 7 is ~15-25 KB at 320px
}
export const THUMB_FILENAME = 'thumb.jpg'

// The thumbnail's own OUTPUT, appended after the HLS output. Everything here is per-output
// (ffmpeg scopes options to the file that follows them), so the segment output above is
// byte-identical to what it was before this feature existed — which matters, because this
// rides in the SAME process as 89 live channels and a mistake here is 89 dead channels.
//   -map 0:v:0  the source's video only. Explicit because the HLS output may be using
//               default stream selection, and default selection does not apply twice.
//   fps=1/N     one frame per interval. The FIRST lands at t=0, so a channel has a
//               thumbnail within a second of coming up rather than one interval later.
//   -update 1   image2 rewrites the SAME path instead of numbering files. A numbered
//               sequence would be a new drive entry per refresh — exactly the append-only
//               growth this design exists to avoid.
//
// ⚠⚠ -map 0:v:0 KILLS A VIDEO-LESS SOURCE, and there is no lenient spelling that saves it.
// Measured (audio-only mpegts): `-map 0:v:0` fails "Stream map '0:v:0' matches no streams",
// and the optional form `-map 0:v:0?` fails too — it maps nothing, and ffmpeg then refuses
// the whole run with "Output file does not contain any stream". Either way ffmpeg exits
// before writing a segment, the watchdog respawns into the identical failure, and after
// SLATE_AFTER failures the slate engages — the slate HAS video, so the thumbnail output
// suddenly succeeds and the channel is PINNED TO BARS with a healthy-looking process.
// The only safe answer is not to emit this output at all unless the channel's video is
// positively known; that gate is channel.js hasKnownVideo/resolveThumb, and THUMB_FAIL_RE
// below is the belt to its braces.
//
// `onGpu` = this spawn decodes on the card (the same flag encodeArgs computes from
// hwDecodeArgs). CUDA frames cannot enter the software `scale` filter — they die with
// "Impossible to convert between the formats", which is one of HW_DECODE_FAIL_RE's
// signatures, so the channel would not merely lose its thumbnail: it would take the sticky
// CPU-decode fallback and give up the ~8x GPU saving for the rest of the run. Download
// them first, exactly the way videoChain spells it for the subtitle/logo round trip.
export function thumbArgs (thumb, outDir, onGpu = false) {
  if (!thumb || !(thumb.intervalSeconds > 0)) return []
  const t = { ...THUMB_DEFAULTS, ...thumb }
  // fps BEFORE the download: dropping 29 of 30 frames on the card is the point — only the
  // frame that survives is ever copied over the PCIe bus.
  const chain = onGpu
    ? [`fps=1/${t.intervalSeconds}`, 'hwdownload', 'format=nv12', `scale=${t.width}:-2`]
    : [`fps=1/${t.intervalSeconds}`, `scale=${t.width}:-2`]
  return [
    '-map', '0:v:0', '-an',
    '-vf', chain.join(','),
    '-c:v', 'mjpeg', '-q:v', String(t.quality),
    '-f', 'image2', '-update', '1',
    path.join(outDir, THUMB_FILENAME)
  ]
}

// ffmpeg stderr that means "the THUMBNAIL output cannot be built for this source" — the
// video-less-source failure above, seen from the log ring. The gate in channel.js should
// already have prevented it (a channel with no known video never gets the output), but a
// source can change under a stale profile — a backup url that turns out to be radio, a
// provider swapping a feed — and the cost of being wrong is a crash loop that ends pinned
// to the slate. So channel.js also matches these and drops the thumbnail output on the
// next respawn, sticky for the life of the run: same shape as HW_DECODE_FAIL_RE, same
// reasoning (one wasted respawn beats a channel that never recovers).
// ⚠ ffmpeg REWORDED this between versions and the production container (5.1.9) is not the
// version this was reproduced on (8.1.2), so both spellings are here. Measured on 8.1.2,
// audio-only mpegts, exit 127: "Stream map '' matches no streams." followed by "Failed to
// set value '0:v:0' for option 'map'". Older builds say "Stream map '0:v:0' matches no
// streams." The `copy` path fails EARLIER and differently — thumbDecodeArgs' -skip_frame is
// refused outright ("Codec AVOption skip_frame ... is not a decoding option") because there
// is no video decoder to skip into — so that is a signature too.
export const THUMB_FAIL_RE = new RegExp([
  "stream map '0:v:0' matches no streams",
  "failed to set value '0:v:0' for option 'map'",
  'does not contain any stream', // the `-map 0:v:0?` shape: nothing mapped, so ffmpeg refuses the output
  'avoption skip_frame',
  'for output file [^\\n]*' + THUMB_FILENAME.replace(/\./g, '\\.')
].join('|'), 'i')

// A COMPLETE JPEG: SOI (FF D8) at the head, EOI (FF D9) at the tail. See mirrorDirToDrive
// for why a torn one must never be published.
export function isCompleteJpeg (buf) {
  if (!buf || buf.length < 4) return false
  return buf[0] === 0xFF && buf[1] === 0xD8 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9
}

// The decoder hint that makes thumbnails survivable on a `copy` channel.
//
// The tempting mental model — "one extra decoded frame every 30 s" — is WRONG, and it is
// the single most expensive misconception in this feature: the fps filter drops frames
// AFTER the decoder has produced them, so a naive thumbnail output turns a remux-only
// channel into a FULL-RATE decode. `-skip_frame nokey` makes the decoder discard
// non-keyframes before decoding them.
//
// Measured (1280x720p30 h264, 2 s GOP, encoder `copy`, 30 s window, 30 s thumb interval):
//   copy baseline                  0.89 CPU-s / 30 s   2.97 % of one core
//   + thumbnail, naive             3.13 CPU-s / 30 s  10.42 %   (+7.5 points)
//   + thumbnail, -skip_frame nokey 1.16 CPU-s / 30 s   3.85 %   (+0.9 points, 88 % saved)
//
// ⚠ Note what does NOT appear in that table: the refresh INTERVAL. With skip_frame the
// decoder still runs at the source's KEYFRAME rate whatever the fps filter asks for, so
// raising THUMB_INTERVAL_SECONDS buys almost nothing. ~0.9 % of a core is the floor for a
// copy channel, which is why they are default-OFF (see resolveThumb in channel.js).
//
// INPUT option, and only ever on `copy`: it is a property of the shared decoder, so on a
// transcoding channel it would silently reduce the CHANNEL to keyframes only. A `copy`
// channel has no other consumer of decoded frames, which is precisely why it is safe there
// and nowhere else. `test` (lavfi) has no bitstream to skip into.
export function thumbDecodeArgs (transcode, thumb, input) {
  if (!thumb || !(thumb.intervalSeconds > 0)) return []
  const encoder = (transcode && transcode.encoder) || TRANSCODE_DEFAULTS.encoder
  if (encoder !== 'copy') return []
  const kind = upgradeInputString(input)?.kind
  if (kind === 'test') return []
  return ['-skip_frame', 'nokey']
}

// --- offline slate -------------------------------------------------------------------
// Pre-rendered "SOURCE OFFLINE" media looped with -c copy when a source is dead, so the
// channel stays live at ~0 CPU instead of going blank in watchdog backoff. Rendered by
// tools/render-slates.sh; see docs/kb/offline-slate.md for the measured properties.

// Ordered so the FIRST match wins. Codec is matched before resolution deliberately: a
// codec change is the one thing a player cannot absorb mid-playlist even at a
// discontinuity (it is a different decoder), whereas a raster change is a decoder
// reconfigure — verified on-device that ExoPlayer/MediaCodec absorbs 854x480 -> 1280x720.
export const SLATE_VARIANTS = [
  { codec: 'hevc', minHeight: 900, file: 'slate-1080p-hevc-aac.ts' },
  { codec: 'hevc', minHeight: 0, file: 'slate-720p-hevc-aac.ts' },
  { codec: 'h264', minHeight: 900, file: 'slate-1080p-h264-aac.ts' },
  { codec: 'h264', minHeight: 0, file: 'slate-720p-h264-aac.ts' }
]
export const SLATE_FALLBACK = 'slate-720p-h264-aac.ts'

// Pick the slate matching a channel's OUTPUT profile. Note OUTPUT, not source: a `copy`
// channel's output is its source, but a transcoding channel's output is whatever the
// encoder produces, and the slate has to match what the playlist has been carrying.
// An unknown/absent profile falls back to 720p h264 — the widest-compatibility entry and
// the one that matches the plurality of the fleet.
export function pickSlateFile (profile) {
  const codec = profile && typeof profile.codec === 'string' ? profile.codec.toLowerCase() : null
  const height = profile && Number.isFinite(profile.height) ? profile.height : 0
  const hit = SLATE_VARIANTS.find((v) => v.codec === codec && height >= v.minHeight)
  return hit ? hit.file : SLATE_FALLBACK
}

// Scrape codec + raster off ffmpeg's stream banner so the slate can match the channel's
// real output. Example line:
//   Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709),
//   1280x720 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 90k tbn
// Returns null for anything that isn't a video stream line, so it can be fed every log
// line cheaply. The raster is matched with a leading comma+space to avoid colliding with
// the `[SAR a:b DAR c:d]` group or a bitrate that happens to contain an 'x'.
//
// ⚠ ONLY index 0 — `Stream #0:N`, never `#1:N`. That first number is the input OR output
// index, and every non-zero one is something that is not this channel's picture:
//   Input #1  the LOGO image (`Stream #1:0: Video: png`) — or the lavfi tone on a `test`
//             source, which is audio and harmless, but the logo is not.
//   Output #1 the rolling THUMBNAIL (`Stream #1:0: Video: mjpeg, ... 320x180`). Measured:
//             without this bound the channel learned `mjpeg 320x180` as its own profile —
//             it is the LAST video banner ffmpeg prints, so it won every time. That is
//             wrong twice over: the slate then matches nothing and falls back to 720p
//             h264, and the thumbnail video gate (channel.js hasKnownVideo) reads its own
//             output as proof the SOURCE has video. Persisting it made it permanent.
// Input #0 and Output #0 are the source and the channel's real output; the output banner
// prints later, so it still wins, which is the OUTPUT-not-source rule pickSlateFile wants.
const VIDEO_LINE_RE = /Stream #0:\d+.*?: Video: ([a-zA-Z0-9_]+)/
const RASTER_RE = /,\s(\d{2,5})x(\d{2,5})(?:[\s,[]|$)/
export function parseVideoProfile (line) {
  if (typeof line !== 'string') return null
  const m = VIDEO_LINE_RE.exec(line)
  if (!m) return null
  const r = RASTER_RE.exec(line)
  return {
    codec: m[1].toLowerCase(),
    width: r ? parseInt(r[1], 10) : null,
    height: r ? parseInt(r[2], 10) : null
  }
}

// Build the full ffmpeg argument list.
// spec = { input, transcode?, hls, thumb?, vaapiDevice? } — input may be a typed object
// (see channel.js normalizeInput) or a legacy string.
// Demuxer tuning that belongs to the SOURCE, not the encode. These exist because cheap
// hardware encoders (the HDMI->RTMP/SRT boxes most small operations actually use) are
// irregular in ways ffmpeg's defaults do not tolerate:
//   probesize / analyzeduration — a sparse or late PMT means ffmpeg gives up before it
//     has seen every elementary stream and fails with "could not find codec parameters",
//     or silently picks up video but not audio. Difficult encoders routinely need 10-50 MB
//     and 10-20 s instead of the 5 MB / 5 s defaults.
//   threadQueueSize — a bursty push listener overflows the small default input queue and
//     ffmpeg logs "Thread message queue blocking; consider raising the thread_queue_size
//     option" while dropping packets. This is REAL input buffering: queue depth between
//     the demuxer and the encoder.
//   discardCorrupt — keep going through corrupt TS packets instead of aborting, which a
//     marginal RF/HDMI capture chain produces constantly.
// All are input options and must precede -i, hence the position in ffmpegArgs below.
// null/absent = use ffmpeg's default, so an untouched channel behaves exactly as before.
export function ingestTuningArgs (t) {
  if (!t) return []
  const out = []
  if (t.probesizeKB != null) out.push('-probesize', String(t.probesizeKB * 1024))
  if (t.analyzeDurationMs != null) out.push('-analyzeduration', String(t.analyzeDurationMs * 1000)) // ffmpeg wants µs
  if (t.threadQueueSize != null) out.push('-thread_queue_size', String(t.threadQueueSize))
  // ⚠ -fflags is ONE option: repeating it OVERRIDES rather than accumulates, so a second
  // -fflags would silently discard the first. Every flag has to be combined into one value.
  //   discardcorrupt — drop corrupt packets instead of aborting (marginal RF/HDMI chains
  //     produce them constantly).
  //   genpts — SYNTHESISE missing presentation timestamps. A stream whose PTS are absent or
  //     non-monotonic makes the HLS muxer emit wrong EXTINF durations or refuse the packet
  //     outright ("Application provided invalid, non monotonically increasing dts"); the
  //     segmenter needs a sane timeline more than it needs the original one.
  //   igndts — ignore DTS entirely and let PTS drive. Pairs with genpts on sources whose
  //     DTS is the broken half; on its own it is the lighter fix.
  const fflags = []
  if (t.discardCorrupt) fflags.push('+discardcorrupt')
  if (t.genPts) fflags.push('+genpts')
  if (t.ignoreDts) fflags.push('+igndts')
  if (fflags.length) out.push('-fflags', fflags.join(''))
  // Keep decoding through bitstream errors rather than treating them as fatal. Separate
  // from discardcorrupt: that one is about the CONTAINER dropping bad packets, this is the
  // DECODER being told to carry on with what it got.
  if (t.ignoreDecodeErrors) out.push('-err_detect', 'ignore_err')
  return out
}

export function ffmpegArgs (spec, outDir) {
  const encoder = (spec.transcode && spec.transcode.encoder) || TRANSCODE_DEFAULTS.encoder
  return [
    ...hwDeviceArgs(encoder, spec.vaapiDevice),
    ...ingestTuningArgs(spec.ingestTuning),
    // -hwaccel is a PER-INPUT option: it applies to the -i that follows it, so it has to
    // sit immediately before inputArgs and after any global device bootstrap.
    ...hwDecodeArgs(spec.transcode, spec.input),
    // Also an input option (a decoder property) — see thumbDecodeArgs for why it exists
    // and why it is confined to `copy`.
    ...thumbDecodeArgs(spec.transcode, spec.thumb, spec.input),
    // ingestTuning also carries HTTP-only source options, which inputArgs applies only on
    // the http(s) branch (they would make ffmpeg fail on a udp/srt input).
    ...inputArgs(spec.input, spec.ingestTuning),
    // The logo is input 1 — it must follow the main -i and precede the graph that uses it.
    ...logoInputArgs(spec.transcode),
    ...encodeArgs(spec.transcode, spec.hls, spec.input),
    ...hlsMuxArgs(spec.hls, outDir),
    // A SECOND output, strictly after the segment output's filename so none of its options
    // can leak onto the media path. Absent entirely when thumbnails are off, so a channel
    // that opts out spawns the exact argv it always did. It is handed the SAME onGpu flag
    // encodeArgs derives — the thumbnail's scale filter lives on the same decoded frames
    // the encoder does, so it needs the same hwdownload discipline.
    ...thumbArgs(spec.thumb, outDir, cudaFrames({ ...TRANSCODE_DEFAULTS, ...(spec.transcode || {}) }, spec.input))
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
          // ⚠ THE THUMBNAIL IS THE ONE FILE WRITTEN NON-ATOMICALLY. ffmpeg's image2 muxer
          // with -update 1 rewrites thumb.jpg IN PLACE (no temp file, no rename), so this
          // 500 ms tick can read it mid-write. Every other file here is safe by luck of how
          // ffmpeg writes it: a segment is written once and then never touched, and
          // index.m3u8 is rewritten but is small enough to land in one write. A torn read
          // here is not a cosmetic glitch — the put SUPERSEDES the previous blob and the
          // clearBlob below then frees the last GOOD picture, so the whole fleet's grid
          // shows a half-decoded cell until the next refresh. Skipping the put (and NOT
          // recording the signature) costs one tick: the next one re-reads the finished
          // file. Cheap because the check is two bytes at each end of ~15 KB.
          if (name === THUMB_FILENAME && !isCompleteJpeg(buf)) continue
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
