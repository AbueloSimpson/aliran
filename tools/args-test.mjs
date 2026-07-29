// Pure-function tests for the S15a broadcaster ingest engine: ffmpeg argument
// builders (hls.js) and input/transcode validation (channel.js). No ffmpeg, no
// network, no disk — safe anywhere. npm run test:args
import assert from 'assert'
import path from 'path'
import {
  ffmpegArgs, inputArgs, encodeArgs, hwDeviceArgs, hlsMuxArgs,
  upgradeInputString, TRANSCODE_DEFAULTS, ingestTuningArgs,
  pickSlateFile, parseVideoProfile, hwDecodeArgs, HW_DECODE_FAIL_RE,
  videoChain, logoInputArgs, parseResolution, mainInputCount
} from '../broadcaster/src/hls.js'
import {
  ControlError, normalizeInput, normalizeTranscode, randomStreamKey,
  isPushInput, pushUrl, pickSource, normalizeIngestTuning, pickSlate, waitLoopIdle, runPool,
  resolveHwDecode, rssCapMb
} from '../broadcaster/src/channel.js'
import { makeIncidents } from '../broadcaster/src/incidents.js'

const log = (...a) => console.log(...a)
const throws = (fn, re, label) => assert.throws(fn, (e) => e instanceof ControlError && e.code === 'bad-request' && re.test(e.message), label)
const HLS = { time: 2, listSize: 6 }

// ===== A: input argument table =====
assert.deepStrictEqual(inputArgs({ kind: 'test' }), [
  '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'])
assert.deepStrictEqual(inputArgs({ kind: 'file', path: '/media/loop.mp4' }),
  ['-re', '-stream_loop', '-1', '-i', '/media/loop.mp4'])
assert.deepStrictEqual(inputArgs({ kind: 'rtmp', port: 5001, streamKey: 'k1k2k3k4k5' }),
  ['-listen', '1', '-f', 'flv', '-i', 'rtmp://0.0.0.0:5001/live/k1k2k3k4k5'])
assert.deepStrictEqual(inputArgs({ kind: 'srt', port: 5002, latencyMs: 250 }),
  ['-i', 'srt://0.0.0.0:5002?mode=listener&latency=250000'])
assert.deepStrictEqual(inputArgs({ kind: 'srt', port: 5002, latencyMs: 200, passphrase: 'super.secret-pass' }),
  ['-i', 'srt://0.0.0.0:5002?mode=listener&latency=200000&passphrase=super.secret-pass'])
assert.deepStrictEqual(inputArgs({ kind: 'udp', port: 5003, timeoutMs: 10000 }),
  ['-i', 'udp://0.0.0.0:5003?fifo_size=5242880&overrun_nonfatal=1&timeout=10000000'])
log('A: push listener / test / file input args ✓')

// ===== B: -re pacing rules on pulls (live sources pace themselves) =====
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'rtsp://cam/main' }),
  ['-rtsp_transport', 'tcp', '-i', 'rtsp://cam/main'], 'rtsp: tcp transport, no -re')
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'rtmp://origin/app/key' }), ['-i', 'rtmp://origin/app/key'])
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'srt://origin:9000' }), ['-i', 'srt://origin:9000'])
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'udp://239.0.0.1:1234' }), ['-i', 'udp://239.0.0.1:1234'])
// Every http(s) pull now carries the reconnect flags so ffmpeg heals a dropped
// connection itself instead of exiting into a watchdog respawn (which also resets the
// seg%d counter and strands orphaned segments).
const RC = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5']
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'https://cdn/live/master.m3u8' }),
  [...RC, '-allowed_extensions', 'ALL', '-i', 'https://cdn/live/master.m3u8'], 'live HLS: no -re, SSAI-tolerant, reconnecting')
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'https://cdn/live/MASTER.M3U8?token=x' }),
  [...RC, '-allowed_extensions', 'ALL', '-i', 'https://cdn/live/MASTER.M3U8?token=x'])
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'https://cdn/vod/movie.mp4' }),
  [...RC, '-re', '-i', 'https://cdn/vod/movie.mp4'], 'http VOD file: -re, and NO reconnect_at_eof (EOF means it ended)')
// ⚠ THE REGRESSION THAT MATTERED: raw mpegts over http has no extension at all, and the
// old rule (".m3u8 = live, everything else = VOD") gave it -re. All 69 production
// channels looked like this. -re throttles the reader to 1x on a source that is already
// realtime, so after any jitter ffmpeg cannot catch up and slow-client drops follow.
for (const live of [
  'http://203.0.113.20:81/SPORTS1_NORTE/mpegts?token=x',
  'http://203.0.113.21:81/CH-9-DEMO-STREAM_1',
  'https://cdn.example/live/feed.ts'
]) {
  const a = inputArgs({ kind: 'pull', url: live })
  assert.ok(!a.includes('-re'), 'live mpegts must NOT be paced with -re: ' + live)
  assert.ok(a.includes('-reconnect_at_eof'), 'live pull retries at EOF: ' + live)
  assert.deepStrictEqual(a.slice(0, RC.length), RC, 'live pull reconnects: ' + live)
}
assert.deepStrictEqual(upgradeInputString('test'), { kind: 'test' })
assert.deepStrictEqual(upgradeInputString('rtsp://cam/1'), { kind: 'pull', url: 'rtsp://cam/1' })
assert.deepStrictEqual(upgradeInputString('C:\\media\\a.mp4'), { kind: 'file', path: 'C:\\media\\a.mp4' })
log('B: pull pacing (-re only for file/test/http-VOD) + string upgrade ✓')

// ===== C: encode args per encoder =====
// Default = pre-S15a behavior with -g 60 replaced by segment-aligned keyframes.
assert.deepStrictEqual(encodeArgs(null, HLS), [
  '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-c:a', 'aac', '-ar', '48000', '-b:a', '128k'])
assert.ok(encodeArgs(null, { time: 4, listSize: 6 }).includes('expr:gte(t,n_forced*4)'), 'keyframes follow hls.time')
assert.deepStrictEqual(encodeArgs({ encoder: 'copy' }, HLS),
  ['-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-b:a', '128k'], 'copy: no keyframe forcing, audio still aac')
// -pix_fmt yuv420p on the CPU-decode nvenc path is LOAD-BEARING, not cosmetic: H.264
// NVENC is 8-bit only, and without it a High 10 source reaches the encoder as yuv420p10le
// and is refused with "No capable devices found" — which reads like a missing GPU. Verified
// against ffmpeg 6.1.1 on an RTX 4090: fails without it, encodes with it, 8-bit unaffected.
assert.deepStrictEqual(encodeArgs({ encoder: 'h264_nvenc', preset: 'balanced', videoBitrateKbps: 2500, fps: 30, resolution: '720p' }, HLS), [
  '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-forced-idr', '1', '-pix_fmt', 'yuv420p',
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
  '-r', '30', '-vf', 'scale=-2:720',
  '-c:a', 'aac', '-ar', '48000', '-b:a', '128k'])
// Both nvenc flags below are load-bearing and were verified against real ffmpeg, so they
// get their own named assertions — a future "tidy up the arg list" must fail loudly here.
assert.ok(encodeArgs({ encoder: 'h264_nvenc' }, HLS).includes('-forced-idr'),
  'nvenc ignores -force_key_frames without -forced-idr: segments never cut and the live window never rolls')
assert.deepStrictEqual(encodeArgs({ encoder: 'h264_qsv', preset: 'quality' }, HLS), [
  '-c:v', 'h264_qsv', '-preset', 'slow',
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-c:a', 'aac', '-ar', '48000', '-b:a', '128k'])
assert.deepStrictEqual(encodeArgs({ encoder: 'h264_vaapi', resolution: '480p' }, HLS), [
  '-c:v', 'h264_vaapi',
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-vf', 'scale=-2:480,format=nv12,hwupload',
  '-c:a', 'aac', '-ar', '48000', '-b:a', '128k'])
assert.deepStrictEqual(encodeArgs({ encoder: 'h264_vaapi' }, HLS).find((a) => a.startsWith('format')), 'format=nv12,hwupload', 'vaapi always hwuploads')
assert.deepStrictEqual(encodeArgs({ encoder: 'h264_amf', preset: 'fast' }, HLS).slice(0, 4),
  ['-c:v', 'h264_amf', '-quality', 'speed'])
assert.deepStrictEqual(encodeArgs({ audioBitrateKbps: 192 }, HLS).slice(-2), ['-b:a', '192k'])
log('C: encoder/preset/bitrate/scale/fps/keyframe args ✓')

// ===== D: hw device bootstrap + full assembly ordering =====
assert.deepStrictEqual(hwDeviceArgs('h264_vaapi', '/dev/dri/renderD129'),
  ['-init_hw_device', 'vaapi=va:/dev/dri/renderD129', '-filter_hw_device', 'va'])
assert.deepStrictEqual(hwDeviceArgs('h264_qsv'), ['-init_hw_device', 'qsv=qsv:hw'])
assert.deepStrictEqual(hwDeviceArgs('libx264'), [])
const outDir = path.join('data', 'out')
assert.deepStrictEqual(ffmpegArgs({ input: 'test', hls: HLS }, outDir), [
  ...inputArgs({ kind: 'test' }),
  ...encodeArgs(null, HLS),
  ...hlsMuxArgs(HLS, outDir)
], 'legacy string input still builds the full pre-S15a pipeline')
const vaapiFull = ffmpegArgs({
  input: { kind: 'udp', port: 5004, timeoutMs: 10000 },
  transcode: { encoder: 'h264_vaapi' },
  hls: HLS,
  vaapiDevice: '/dev/dri/renderD128'
}, outDir)
assert.strictEqual(vaapiFull[0], '-init_hw_device', 'hw device init is a global option')
assert.ok(vaapiFull.indexOf('-init_hw_device') < vaapiFull.indexOf('-i'), 'hw init precedes -i')
assert.deepStrictEqual(hlsMuxArgs(HLS, outDir).slice(-2),
  [path.join(outDir, 'seg%d.ts'), path.join(outDir, 'index.m3u8')].slice(-2))
log('D: hw device init + full ffmpegArgs assembly ✓')

// ===== E: normalizeInput — string upgrades =====
const cfg = { rtmpPort: 1935, ingest: { portBase: 5000, portMax: 5004 } }
assert.deepStrictEqual(normalizeInput('test', { config: cfg }), { kind: 'test' })
const upgraded = normalizeInput('rtmp', { config: cfg })
assert.strictEqual(upgraded.kind, 'rtmp')
assert.strictEqual(upgraded.port, 1935, "'rtmp' shorthand uses RTMP_PORT")
assert.match(upgraded.streamKey, /^[A-Za-z0-9]{22}$/, 'stream key generated')
assert.deepStrictEqual(normalizeInput('https://cdn/a.m3u8', { config: cfg }), { kind: 'pull', url: 'https://cdn/a.m3u8' })
assert.deepStrictEqual(normalizeInput('/media/a.mp4', { config: cfg }), { kind: 'file', path: '/media/a.mp4' })
throws(() => normalizeInput('file:///etc/passwd', { config: cfg }), /scheme/, 'file: url rejected')
throws(() => normalizeInput({ kind: 'pull', url: 'ftp://x/y' }, { config: cfg }), /scheme/)
throws(() => normalizeInput('a\nb', { config: cfg }), /invalid input/)
throws(() => normalizeInput('x'.repeat(513), { config: cfg }), /invalid input/)
throws(() => normalizeInput(null, { config: cfg }), /required/)
throws(() => normalizeInput({ kind: 'weird' }, { config: cfg }), /input\.kind/)
// A typed input that arrived STRINGIFIED must be a loud 400, never the file catch-all:
// storing the blob as a path is what silently killed four production channels on
// 2026-07-24 (see mcp/src/tools/broadcaster.js, which rescues the same shape earlier).
throws(() => normalizeInput('{"kind":"pull","url":"http://host:8081/x/playlist.m3u8"}', { config: cfg }), /looks like JSON/, 'stringified typed input rejected')
throws(() => normalizeInput('  {"kind":"test"}', { config: cfg }), /looks like JSON/, 'leading whitespace does not hide it')
throws(() => normalizeInput('{not even json', { config: cfg }), /looks like JSON/, 'brace-leading is enough — we never guess it is a path')
assert.deepStrictEqual(normalizeInput('/media/{a}/x.mp4', { config: cfg }), { kind: 'file', path: '/media/{a}/x.mp4' }, 'a brace INSIDE a path is still a path')
log('E: string auto-upgrade + scheme whitelist + stringified-object rejection ✓')

// ===== F: ports — range, uniqueness, allocation =====
throws(() => normalizeInput({ kind: 'udp', port: 80 }, { config: cfg }), /1024-65535/)
throws(() => normalizeInput({ kind: 'udp', port: 70000 }, { config: cfg }), /1024-65535/)
throws(() => normalizeInput({ kind: 'udp', port: 5000.5 }, { config: cfg }), /integer/)
throws(() => normalizeInput({ kind: 'udp', port: 5000 }, { config: cfg, usedPorts: new Set([5000]) }), /already used/)
assert.strictEqual(normalizeInput({ kind: 'udp' }, { config: cfg }).port, 5000, 'auto-alloc starts at the base')
assert.strictEqual(normalizeInput({ kind: 'udp' }, { config: cfg, usedPorts: new Set([5000, 5001]) }).port, 5002, 'auto-alloc skips used ports')
throws(() => normalizeInput({ kind: 'udp' }, { config: cfg, usedPorts: new Set([5000, 5001, 5002, 5003, 5004]) }), /no free ingest port/)
const udp = normalizeInput({ kind: 'udp', port: 6000 }, { config: cfg })
assert.strictEqual(udp.timeoutMs, 10000, 'udp timeout default')
throws(() => normalizeInput({ kind: 'udp', timeoutMs: 999 }, { config: cfg }), /timeoutMs/)
throws(() => normalizeInput({ kind: 'udp', timeoutMs: 60001 }, { config: cfg }), /timeoutMs/)
log('F: port range/uniqueness/auto-allocation ✓')

// ===== G: rtmp stream keys + srt passphrases (rules + PATCH inheritance) =====
throws(() => normalizeInput({ kind: 'rtmp', streamKey: 'abc' }, { config: cfg }), /8-64/)
throws(() => normalizeInput({ kind: 'rtmp', streamKey: 'has-dashes-123' }, { config: cfg }), /8-64 letters\/digits/)
const rtmpEx = { kind: 'rtmp', port: 5001, streamKey: 'StableKey123' }
const inherited = normalizeInput({ kind: 'rtmp' }, { config: cfg, existing: rtmpEx })
assert.strictEqual(inherited.port, 5001, 'same-kind PATCH inherits the port')
assert.strictEqual(inherited.streamKey, 'StableKey123', 'same-kind PATCH inherits the stream key')
assert.strictEqual(normalizeInput({ kind: 'rtmp', streamKey: 'FreshKey12345' }, { config: cfg, existing: rtmpEx }).streamKey, 'FreshKey12345')
assert.strictEqual(normalizeInput({ kind: 'udp' }, { config: cfg, existing: rtmpEx }).port, 5000, 'kind change drops inheritance')
const envRe = normalizeInput('rtmp', { config: cfg, existing: rtmpEx })
assert.strictEqual(envRe.streamKey, 'StableKey123', "env INPUT=rtmp reboot keeps the persisted key")

throws(() => normalizeInput({ kind: 'srt', passphrase: 'short' }, { config: cfg }), /passphrase/)
throws(() => normalizeInput({ kind: 'srt', passphrase: 'has space here!' }, { config: cfg }), /passphrase/)
throws(() => normalizeInput({ kind: 'srt', latencyMs: 19 }, { config: cfg }), /latencyMs/)
throws(() => normalizeInput({ kind: 'srt', latencyMs: 5001 }, { config: cfg }), /latencyMs/)
const srt = normalizeInput({ kind: 'srt', passphrase: 'super.secret_1' }, { config: cfg })
assert.strictEqual(srt.latencyMs, 200, 'srt latency default')
assert.strictEqual(srt.passphrase, 'super.secret_1')
const srtEx = { kind: 'srt', port: 5001, latencyMs: 300, passphrase: 'inherited.pass1' }
const srtInh = normalizeInput({ kind: 'srt' }, { config: cfg, existing: srtEx })
assert.strictEqual(srtInh.passphrase, 'inherited.pass1')
assert.strictEqual(srtInh.latencyMs, 300)
assert.strictEqual(normalizeInput({ kind: 'srt', passphrase: null }, { config: cfg, existing: srtEx }).passphrase, undefined, 'passphrase:null clears')
log('G: stream key / passphrase rules + inheritance ✓')

// ===== H: normalizeTranscode =====
assert.strictEqual(normalizeTranscode(null), null)
assert.deepStrictEqual(normalizeTranscode({}), { ...TRANSCODE_DEFAULTS })
throws(() => normalizeTranscode({ encoder: 'h265' }), /encoder/)
throws(() => normalizeTranscode({ resolution: '4k' }), /resolution/)
throws(() => normalizeTranscode({ fps: 23 }), /fps/)
throws(() => normalizeTranscode({ videoBitrateKbps: 99 }), /videoBitrateKbps/)
throws(() => normalizeTranscode({ videoBitrateKbps: 20001 }), /videoBitrateKbps/)
throws(() => normalizeTranscode({ audioBitrateKbps: 63 }), /audioBitrateKbps/)
throws(() => normalizeTranscode({ audioBitrateKbps: 321 }), /audioBitrateKbps/)
throws(() => normalizeTranscode({ preset: 'ultra' }), /preset/)
throws(() => normalizeTranscode({ encoder: 'copy', resolution: '720p' }), /copy/)
throws(() => normalizeTranscode({ encoder: 'copy', fps: 30 }), /copy/)
throws(() => normalizeTranscode({ encoder: 'copy', videoBitrateKbps: 1000 }), /copy/)
assert.deepStrictEqual(normalizeTranscode({ encoder: 'copy' }), { ...TRANSCODE_DEFAULTS, encoder: 'copy' })
const t = normalizeTranscode({ encoder: 'h264_nvenc', fps: '30', videoBitrateKbps: 4500, preset: 'quality' })
assert.strictEqual(t.fps, 30, 'numeric-string fps coerced')
assert.strictEqual(t.videoBitrateKbps, 4500)
log('H: transcode validation (values, bounds, copy constraints) ✓')

// ===== I: helpers =====
const key = randomStreamKey()
assert.match(key, /^[A-Za-z0-9]{22}$/)
assert.notStrictEqual(randomStreamKey(), key)
assert.ok(isPushInput({ kind: 'srt', port: 5000 }))
assert.ok(!isPushInput({ kind: 'pull', url: 'rtsp://x' }))
assert.ok(!isPushInput('test'))
assert.strictEqual(pushUrl({ kind: 'rtmp', port: 5001, streamKey: 'Key1234567' }, 'vps.example'),
  'rtmp://vps.example:5001/live/Key1234567')
assert.strictEqual(pushUrl({ kind: 'srt', port: 5002, latencyMs: 200, passphrase: 'pp.pp.pp.pp' }, null),
  'srt://<this-host>:5002?latency=200000&passphrase=pp.pp.pp.pp')
assert.strictEqual(pushUrl({ kind: 'udp', port: 5003, timeoutMs: 1000 }, 'h'), 'udp://h:5003')
assert.strictEqual(pushUrl({ kind: 'test' }, 'h'), null)
log('I: randomStreamKey / isPushInput / pushUrl ✓')

// ===== J: backup sources — validation =====
const P = 'http://a/1.m3u8'; const B1 = 'http://b/2.m3u8'; const B2 = 'srt://c:9000'
assert.deepStrictEqual(normalizeInput({ kind: 'pull', url: P }), { kind: 'pull', url: P })
// no fallbacks => the key is absent entirely, not an empty array (keeps records small
// and means an existing catalog/channels.json is byte-identical after an upgrade)
assert.ok(!('fallbacks' in normalizeInput({ kind: 'pull', url: P })), 'no empty fallbacks key')
assert.deepStrictEqual(normalizeInput({ kind: 'pull', url: P, fallbacks: [B1, B2] }),
  { kind: 'pull', url: P, fallbacks: [B1, B2] })
// dupes and echoes of the primary are dropped, order preserved
assert.deepStrictEqual(normalizeInput({ kind: 'pull', url: P, fallbacks: [B1, B1, P, B2] }),
  { kind: 'pull', url: P, fallbacks: [B1, B2] })
// a backup must pass the SAME rules as a primary
throws(() => normalizeInput({ kind: 'pull', url: P, fallbacks: ['ftp://nope/x'] }), /fallback url scheme/, 'bad fallback scheme')
throws(() => normalizeInput({ kind: 'pull', url: P, fallbacks: ['http://a/' + 'x'.repeat(512)] }), /1-512/, 'long fallback')
throws(() => normalizeInput({ kind: 'pull', url: P, fallbacks: ['http://a/x\ny'] }), /1-512/, 'CRLF fallback')
throws(() => normalizeInput({ kind: 'pull', url: P, fallbacks: 'nope' }), /must be an array/, 'non-array')
throws(() => normalizeInput({ kind: 'pull', url: P, fallbacks: [B1, B2, 'http://d/4', 'http://e/5', 'http://f/6'] }), /at most 4/, 'cap')
// PATCH semantics: omitted keeps stored, explicit [] clears
const stored = { kind: 'pull', url: P, fallbacks: [B1] }
assert.deepStrictEqual(normalizeInput({ kind: 'pull', url: P }, { existing: stored }), stored, 'omitted inherits')
assert.ok(!('fallbacks' in normalizeInput({ kind: 'pull', url: P, fallbacks: [] }, { existing: stored })), 'explicit [] clears')
log('J: backup source validation (dupes, scheme, cap, inherit/clear) ✓')

// ===== K: backup sources — rotation decision (fail forward, return to primary) =====
const S3 = ['p', 'b1', 'b2']
const roll = (st) => pickSource({ sources: S3, failoverAfter: 2, primaryRetryMs: 300000, ...st })
// a single failure does NOT move (one ffmpeg exit is normal on flaky IPTV)
assert.strictEqual(roll({ srcIndex: 0, srcFailures: 1, now: 0 }).srcIndex, 0, '1 failure holds')
// a run of them fails forward, and resets the counter so each url gets a fair trial
const f1 = roll({ srcIndex: 0, srcFailures: 2, now: 0 })
assert.deepStrictEqual([f1.srcIndex, f1.srcFailures, f1.reason], [1, 0, 'failover'], 'fail forward')
// ... and wraps around the ring
assert.strictEqual(roll({ srcIndex: 2, srcFailures: 2, lastPrimaryTryAt: 0, now: 1000 }).srcIndex, 0, 'ring wraps')
// on a backup, before the cooldown: stay put when healthy
assert.strictEqual(roll({ srcIndex: 1, srcFailures: 0, lastPrimaryTryAt: 0, now: 1000 }).srcIndex, 1, 'healthy backup holds')
// after the cooldown: come home even though nothing failed — this is return-to-primary
const home = roll({ srcIndex: 1, srcFailures: 0, lastPrimaryTryAt: 0, now: 300000 })
assert.deepStrictEqual([home.srcIndex, home.reason], [0, 'primary-retry'], 'returns to primary')
// return-to-primary OUTRANKS failover, so a failing backup can't lap the ring forever
// without ever re-probing the primary
assert.strictEqual(roll({ srcIndex: 1, srcFailures: 9, lastPrimaryTryAt: 0, now: 300000 }).reason, 'primary-retry', 'primary wins over failover')
// wrapping onto the primary re-arms the cooldown, so we don't instantly "retry" it again
assert.strictEqual(roll({ srcIndex: 2, srcFailures: 2, lastPrimaryTryAt: 0, now: 5000 }).lastPrimaryTryAt, 5000, 'wrap re-arms cooldown')
// a single-source channel never rotates, whatever the failure count
assert.strictEqual(pickSource({ sources: ['only'], srcIndex: 0, srcFailures: 99 }).srcIndex, 0, 'single source pinned')
assert.strictEqual(pickSource({ sources: [], srcFailures: 99 }).srcIndex, 0, 'no sources pinned')
log('K: backup source rotation (hold, fail forward, wrap, return to primary) ✓')

// ===== L: incident correlation (fleet-restart detection) =====
// The whole point: ONE channel respawning is noise (~2.5/channel/hour on flaky IPTV),
// so it must NOT be logged; forty inside two minutes is an outage and must be. This is
// exactly what was missing when all 69 channels bounced together on 2026-07-21.
let now = 0
const inc = makeIncidents({ windowMs: 1000, minChannels: 5, capacity: 10, clock: () => now })

// under the threshold: pure churn, nothing recorded at all
for (let i = 0; i < 4; i++) { now += 10; assert.strictEqual(inc.restart('ch' + i, 8), null, 'below threshold is silent') }
assert.strictEqual(inc.list().length, 0, 'ordinary churn must not fill the ring')

// the 5th DISTINCT channel inside the window trips it — one incident, not five
now += 10
let ev = inc.restart('ch4', 8) // small fleet: the absolute floor of 5 applies
assert.ok(ev && ev.type === 'fleet-restart', 'burst opens a fleet incident')
assert.strictEqual(ev.channels, 5, 'counts distinct channels')
assert.strictEqual(ev.of, 8, 'records the fleet size it happened against')
assert.strictEqual(inc.list().length, 1, 'a burst is ONE incident')

// more restarts EXTEND that incident rather than emitting new ones — otherwise a fleet
// event floods the ring and evicts its own beginning
now += 10; inc.restart('ch5', 8)
now += 10; inc.restart('ch6', 8)
assert.strictEqual(inc.list().length, 1, 'burst still one incident')
assert.strictEqual(inc.list()[0].channels, 7, 'extended in place')
assert.ok(inc.list()[0].lastAt > inc.list()[0].firstAt, 'incident spans a duration')

// the SAME channel flapping repeatedly is NOT a fleet event — distinct channels is the test
const solo = makeIncidents({ windowMs: 1000, minChannels: 5, clock: () => now })
for (let i = 0; i < 20; i++) { now += 5; solo.restart('flappy') }
assert.strictEqual(solo.list().length, 0, 'one channel flapping 20x is not a fleet event')

// once the window passes, a fresh burst is a NEW incident
now += 5000
for (let i = 0; i < 5; i++) { now += 10; inc.restart('later' + i, 8) }
assert.strictEqual(inc.list().length, 2, 'a later burst is a separate incident')
assert.strictEqual(inc.list()[0].channels, 5, 'newest first, fresh count')

// discrete events are always recorded on their own
inc.record('source-failover', { channel: 'sports-2', index: 1, of: 3 })
assert.strictEqual(inc.list()[0].type, 'source-failover', 'discrete events land immediately')

// the ring is bounded
const cap = makeIncidents({ capacity: 3, clock: () => now })
for (let i = 0; i < 10; i++) cap.record('x', { i })
assert.strictEqual(cap._size(), 3, 'ring is bounded')

// ⚠ THE THRESHOLD SCALES WITH FLEET SIZE. Measured churn on the live box is ~5 distinct
// channels per 2 min at 68 channels, so a FLAT floor of 5 would fire continuously. With
// minFraction the same churn stays silent on a big fleet but still trips a small one.
const big = makeIncidents({ windowMs: 1000, minChannels: 5, minFraction: 0.25, clock: () => now })
for (let i = 0; i < 10; i++) { now += 5; big.restart('c' + i, 69) } // 10 of 69 = 14%
assert.strictEqual(big.list().length, 0, '10 of 69 channels is churn, not a fleet event')
for (let i = 10; i < 18; i++) { now += 5; big.restart('c' + i, 69) } // 18 of 69 = 26%
assert.strictEqual(big.list().length, 1, 'crossing 25% of the fleet IS a fleet event')
assert.strictEqual(big.list()[0].channels, 18, 'reports the distinct-channel count')

// a small deployment still trips on the absolute floor (5 of 6 really is fleet-wide)
const small = makeIncidents({ windowMs: 1000, minChannels: 5, minFraction: 0.25, clock: () => now })
for (let i = 0; i < 5; i++) { now += 5; small.restart('s' + i, 6) }
assert.strictEqual(small.list().length, 1, 'minChannels is the floor for small fleets')
// ===== M: per-channel demuxer tuning (the cheap-HDMI-encoder knobs) =====
// These exist because hardware encoders with a sparse/late PMT need far more probe than
// ffmpeg's defaults, and a bursty push listener overflows the small default input queue.
assert.deepStrictEqual(ingestTuningArgs(null), [], 'absent = ffmpeg defaults, args unchanged')
assert.deepStrictEqual(ingestTuningArgs({}), [], 'empty = ffmpeg defaults')
assert.deepStrictEqual(ingestTuningArgs({ probesizeKB: 50000 }), ['-probesize', '51200000'], 'KB → bytes')
assert.deepStrictEqual(ingestTuningArgs({ analyzeDurationMs: 20000 }), ['-analyzeduration', '20000000'], 'ms → µs (ffmpeg wants microseconds)')
assert.deepStrictEqual(ingestTuningArgs({ threadQueueSize: 2048 }), ['-thread_queue_size', '2048'])
assert.deepStrictEqual(ingestTuningArgs({ discardCorrupt: true }), ['-fflags', '+discardcorrupt'])
assert.deepStrictEqual(ingestTuningArgs({ discardCorrupt: false }), [], 'false must not emit the flag')
// they are INPUT options: must land before -i or ffmpeg ignores them for the input
const tuned = ffmpegArgs({ input: { kind: 'rtmp', port: 5001, streamKey: 'k1k2k3k4k5' }, ingestTuning: { probesizeKB: 50000, threadQueueSize: 2048 }, hls: HLS }, outDir)
assert.ok(tuned.indexOf('-probesize') < tuned.indexOf('-i'), 'probesize precedes -i')
assert.ok(tuned.indexOf('-thread_queue_size') < tuned.indexOf('-i'), 'thread_queue_size precedes -i')
// validation: wide ranges (50 MB probe is NORMAL for a bad encoder), but bounded
assert.strictEqual(normalizeIngestTuning(null), null)
assert.deepStrictEqual(normalizeIngestTuning({ probesizeKB: 50000, discardCorrupt: 'yes' }), { probesizeKB: 50000, discardCorrupt: true })
assert.deepStrictEqual(normalizeIngestTuning({ probesizeKB: '' }), null, 'blank clears back to the ffmpeg default')
throws(() => normalizeIngestTuning({ probesizeKB: 8 }), /32-102400/, 'probe floor')
throws(() => normalizeIngestTuning({ analyzeDurationMs: 999999 }), /100-60000/, 'analyze ceiling')
throws(() => normalizeIngestTuning({ threadQueueSize: 2.5 }), /8-65536/, 'must be an integer')
// partial update: omitted keeps the stored value, explicit blank clears it
assert.deepStrictEqual(normalizeIngestTuning({ threadQueueSize: 512 }, { probesizeKB: 40000 }), { probesizeKB: 40000, threadQueueSize: 512 }, 'omitted key inherits')
log('M: ingest tuning (probesize/analyzeduration/thread_queue/discardcorrupt, unit conversion, before -i, bounds, inherit) ✓')

log('L: incident correlation (churn silent, burst = one extended incident, per-channel flap ignored, bounded) ✓')

// ===== N: offline slate =====
// Variant matching is codec-FIRST: a codec change is the one thing a player cannot absorb
// mid-playlist even at a discontinuity, whereas a raster change is a decoder reconfigure.
assert.strictEqual(pickSlateFile({ codec: 'h264', height: 720 }), 'slate-720p-h264-aac.ts')
assert.strictEqual(pickSlateFile({ codec: 'h264', height: 1080 }), 'slate-1080p-h264-aac.ts')
assert.strictEqual(pickSlateFile({ codec: 'hevc', height: 720 }), 'slate-720p-hevc-aac.ts')
assert.strictEqual(pickSlateFile({ codec: 'hevc', height: 1080 }), 'slate-1080p-hevc-aac.ts')
// the fleet's odd rasters (854x480, 852x720, 720x480, 1024x576) are all sub-900 → 720p,
// which is aspect-correct for them because every one is anamorphic 16:9 (see the KB page)
assert.strictEqual(pickSlateFile({ codec: 'h264', height: 480 }), 'slate-720p-h264-aac.ts')
assert.strictEqual(pickSlateFile({ codec: 'hevc', height: 576 }), 'slate-720p-hevc-aac.ts')
// unknown / absent / exotic codec must never throw — it falls back to the widest variant
assert.strictEqual(pickSlateFile(null), 'slate-720p-h264-aac.ts', 'no profile → fallback')
assert.strictEqual(pickSlateFile({}), 'slate-720p-h264-aac.ts', 'empty profile → fallback')
assert.strictEqual(pickSlateFile({ codec: 'mpeg2video', height: 576 }), 'slate-720p-h264-aac.ts')
assert.strictEqual(pickSlateFile({ codec: 'H264', height: 1080 }), 'slate-1080p-h264-aac.ts', 'codec match is case-insensitive')

// banner scraping: must pick the raster, not the SAR/DAR group or a bitrate
assert.deepStrictEqual(
  parseVideoProfile('  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709), 1280x720 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 90k tbn'),
  { codec: 'h264', width: 1280, height: 720 })
assert.deepStrictEqual(
  parseVideoProfile('  Stream #0:0[0x100]: Video: hevc (Main) ([36][0][0][0] / 0x0024), yuvj420p(pc), 1920x1080, 30 fps, 30 tbr, 90k tbn'),
  { codec: 'hevc', width: 1920, height: 1080 })
assert.strictEqual(parseVideoProfile('  Stream #0:1[0x101]: Audio: aac (LC), 48000 Hz, stereo, fltp, 130 kb/s'), null, 'audio line is not a profile')
assert.strictEqual(parseVideoProfile('frame= 123 fps=30 q=-1.0 size=N/A time=00:00:04.10'), null, 'progress line is not a profile')
assert.strictEqual(parseVideoProfile(null), null)

// state machine: enter after `after` x sources failures, leave only to re-probe
const S = { enabled: true, after: 3, retryMs: 60000 }
assert.strictEqual(pickSlate({ ...S, failures: 2, sources: 1 }).slated, false, 'below threshold stays on source')
assert.strictEqual(pickSlate({ ...S, failures: 3, sources: 1 }).slated, true, '1 url slates at 3')
assert.strictEqual(pickSlate({ ...S, failures: 3, sources: 2 }).slated, false, 'threshold scales with fallbacks')
assert.strictEqual(pickSlate({ ...S, failures: 6, sources: 2 }).slated, true, 'every fallback got its attempts')
assert.strictEqual(pickSlate({ ...S, failures: 99, enabled: false }).slated, false, 'disabled never slates')
assert.strictEqual(pickSlate({ ...S, slated: true, slateSince: 1000, now: 2000 }).slated, true, 'stays slated inside retryMs')
const retry = pickSlate({ ...S, slated: true, slateSince: 1000, now: 1000 + 60000 })
assert.strictEqual(retry.slated, false, 'drops the slate to re-probe the source')
assert.strictEqual(retry.reason, 'slate-retry')
// a still-dead source must re-slate on its very next failure, not sit blank for another
// `after` window — this is why `failures` is not reset when leaving to probe
assert.strictEqual(pickSlate({ ...S, slated: false, failures: 7, sources: 2 }).slated, true, 're-slates immediately after a failed probe')
assert.strictEqual(pickSlate({ ...S, slated: true, enabled: false }).reason, 'slate-disabled')
log('N: offline slate (variant matching, banner scraping, enter/retry state machine) ✓')

// the discontinuity marker is what makes a slate's codec/resolution change legal
// mid-playlist, and it also marks the backwards-DTS every ordinary respawn already causes
assert.ok(hlsMuxArgs(HLS, outDir).join(' ').includes('delete_segments+append_list+omit_endlist+discont_start'),
  'every spawn must mark its first segment with EXT-X-DISCONTINUITY')
log('O: HLS discontinuity flag on every spawn ✓')

// ===== P: adaptive boot-resume pacing (waitLoopIdle) =====
// Injected clock + sleeper so the loop-lag logic is deterministic and instant (no real waits).
{
  // idle loop: sleep(sampleMs) advances exactly sampleMs → lag 0 → returns after ONE sample
  let t = 0; let n = 0
  const now = () => t
  const sleepIdle = (ms) => { n++; t += ms; return Promise.resolve() }
  const a = await waitLoopIdle({ targetLagMs: 50, maxWaitMs: 3000, sampleMs: 100 }, { now, sleep: sleepIdle })
  assert.strictEqual(n, 1, 'idle loop returns after a single sample')
  assert.strictEqual(a.lag, 0)
  assert.strictEqual(a.timedOut, false)

  // busy loop: every sample overruns by 200 ms (lag 200 > target) → keeps sampling until the
  // maxWaitMs deadline, then returns timedOut so a permanently-busy loop still makes progress
  t = 0; n = 0
  const sleepBusy = (ms) => { n++; t += ms + 200; return Promise.resolve() }
  const b = await waitLoopIdle({ targetLagMs: 50, maxWaitMs: 1000, sampleMs: 100 }, { now, sleep: sleepBusy })
  assert.strictEqual(b.timedOut, true, 'busy loop is bounded by maxWaitMs')
  assert.ok(b.lag > 50, 'busy loop reports real lag')
  assert.ok(n >= 3 && n <= 5, `busy loop samples within the deadline (got ${n})`)

  // loop that recovers mid-wait: first sample lags, second is clean → returns not-timed-out
  t = 0; n = 0
  const sleepRecover = (ms) => { n++; t += ms + (n === 1 ? 500 : 0); return Promise.resolve() }
  const c = await waitLoopIdle({ targetLagMs: 50, maxWaitMs: 5000, sampleMs: 100 }, { now, sleep: sleepRecover })
  assert.strictEqual(n, 2, 'stops sampling once the loop catches up')
  assert.strictEqual(c.timedOut, false)
}
log('P: adaptive boot-resume pacing (idle→1 sample, busy→bounded, recovers→stops) ✓')

// ===== Q: bounded-concurrency resume pool (runPool) =====
{
  // never exceeds the concurrency limit, processes everything, runs the gate per launch
  let inflight = 0; let maxInflight = 0; let gate = 0; const done = []
  const items = [...Array(20).keys()]
  await runPool(items, async (x) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight)
    await new Promise((r) => setTimeout(r, 2)); done.push(x); inflight--
  }, { concurrency: 4, gate: async () => { gate++ }, onSettle: () => {} })
  assert.strictEqual(done.length, 20, 'all items processed')
  assert.ok(maxInflight <= 4, `never exceeds concurrency (max ${maxInflight})`)
  assert.ok(maxInflight > 1, 'actually overlaps (not sequential)')
  assert.strictEqual(gate, 20, 'gate awaited once per launch')

  // a worker rejection is isolated — the rest of the pool still completes
  let ok = 0
  await runPool([...Array(10).keys()], async (x) => { if (x === 3) throw new Error('boom'); ok++ }, { concurrency: 3 })
  assert.strictEqual(ok, 9, 'one failure does not strand the pool')

  // concurrency 1 is strictly sequential (the unpaced fallback)
  let mi = 0; let inf = 0
  await runPool([...Array(6).keys()], async () => { inf++; mi = Math.max(mi, inf); await new Promise((r) => setTimeout(r, 1)); inf-- }, { concurrency: 1 })
  assert.strictEqual(mi, 1, 'concurrency 1 = sequential')

  // onSettle fires once per item (the resume progress counter)
  let settled = 0
  await runPool([...Array(7).keys()], async () => {}, { concurrency: 3, onSettle: () => { settled++ } })
  assert.strictEqual(settled, 7, 'onSettle fires once per item')
}
log('Q: bounded-concurrency resume pool (bound respected, overlaps, failure-isolated, seq fallback) ✓')

// ===== R: GPU decode path (CUVID → scale_cuda → nvenc) + device pinning =====
// Every expectation here was checked against real ffmpeg 6.1.1 on a 2x RTX 4090 host
// before it was written down — the arg vectors this builder produces were run against
// that box and the resulting HLS output inspected, not merely eyeballed as strings.
// Measured there, 1080p30 → 720p/3000k over 30 s of content:
//   full CUDA (cuvid → scale_cuda → nvenc)  1.6 CPU-s   = 0.053 cores per realtime stream
//   nvenc with CPU decode + CPU scale      12.9 CPU-s   = 0.43  cores
//   libx264 veryfast                       25.0 CPU-s   = 0.83  cores
// So the CUDA path is ~8x cheaper than the nvenc path it replaces. CPU is not the real
// ceiling either way: NVENC on GeForce caps at 8 concurrent encode sessions per GPU.

// 'auto' is NOT self-resolving in the pure builder — it has no way to see the host, so it
// means "off" here and channel.js turns it into a real boolean against the probe.
assert.deepStrictEqual(hwDecodeArgs({ encoder: 'h264_nvenc', hwDecode: 'auto' }, { kind: 'pull', url: 'http://o/s' }), [],
  'unresolved auto = off in the pure builder')
assert.deepStrictEqual(hwDecodeArgs({ encoder: 'h264_nvenc', hwDecode: false }, { kind: 'pull', url: 'http://o/s' }), [])
assert.deepStrictEqual(hwDecodeArgs({ encoder: 'h264_nvenc', hwDecode: true }, { kind: 'pull', url: 'http://o/s' }),
  ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'])
assert.deepStrictEqual(hwDecodeArgs({ encoder: 'h264_nvenc', hwDecode: true, gpu: 1 }, { kind: 'pull', url: 'http://o/s' }),
  ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-hwaccel_device', '1'], 'gpu pins the DECODER too')
assert.deepStrictEqual(hwDecodeArgs({ encoder: 'h264_nvenc', hwDecode: true, gpu: 0 }, { kind: 'pull', url: 'http://o/s' }).slice(-2),
  ['-hwaccel_device', '0'], 'gpu 0 is a real selection, not a falsy skip')
// A CPU encoder or `copy` never takes the CUDA path, and lavfi has no bitstream to decode.
for (const enc of ['libx264', 'copy', 'h264_qsv', 'h264_vaapi']) {
  assert.deepStrictEqual(hwDecodeArgs({ encoder: enc, hwDecode: true }, { kind: 'pull', url: 'http://o/s' }), [], `${enc}: no cuda decode`)
}
assert.deepStrictEqual(hwDecodeArgs({ encoder: 'h264_nvenc', hwDecode: true }, { kind: 'test' }), [],
  'test input synthesises raw frames — nothing to hw-decode')
assert.ok(hwDecodeArgs({ encoder: 'h264_nvenc', hwDecode: true }, { kind: 'file', path: '/m/a.mp4' }).length > 0, 'file input decodes')

// On the GPU the scaler must be scale_cuda (plain scale would need a download first), and
// -pix_fmt must be ABSENT — it would force the frame back to system memory.
const gpuArgs = encodeArgs({ encoder: 'h264_nvenc', hwDecode: true, resolution: '720p', videoBitrateKbps: 3000 }, HLS, { kind: 'pull', url: 'http://o/s' })
assert.ok(gpuArgs.includes('scale_cuda=-2:720'), 'gpu path scales on the card')
assert.ok(!gpuArgs.includes('scale=-2:720'), 'no cpu scaler on the gpu path')
assert.ok(!gpuArgs.includes('-pix_fmt'), 'no -pix_fmt on the gpu path (would download the frame)')
const cpuArgs = encodeArgs({ encoder: 'h264_nvenc', hwDecode: false, resolution: '720p' }, HLS, { kind: 'pull', url: 'http://o/s' })
assert.ok(cpuArgs.includes('scale=-2:720') && !cpuArgs.join(' ').includes('scale_cuda'), 'cpu path scales on the cpu')
assert.deepStrictEqual(cpuArgs.slice(0, 10),
  ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll', '-forced-idr', '1', '-pix_fmt', 'yuv420p'], 'cpu path forces 8-bit')
assert.ok(gpuArgs.includes('-forced-idr'), 'the GPU path needs forced IDR just as much as the CPU one')
// resolution 'source' on the GPU: frames stay CUDA with no filter at all, which nvenc takes directly.
const gpuNoScale = encodeArgs({ encoder: 'h264_nvenc', hwDecode: true }, HLS, { kind: 'pull', url: 'http://o/s' })
assert.ok(!gpuNoScale.includes('-vf'), 'no filter needed when not rescaling')
assert.deepStrictEqual(encodeArgs({ encoder: 'h264_nvenc', hwDecode: true, gpu: 1 }, HLS, { kind: 'pull', url: 'http://o/s' }).slice(0, 10),
  ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll', '-forced-idr', '1', '-gpu', '1'], 'gpu pins the ENCODER too')

// Full assembly: -hwaccel is a per-input option, so it must land before the -i it applies
// to. Getting this order wrong makes ffmpeg ignore it and silently decode on the CPU —
// which is exactly the failure this whole path exists to avoid, and it is invisible in
// the output, so the ordering is asserted rather than assumed.
const gpuFull = ffmpegArgs({
  input: { kind: 'pull', url: 'http://origin:81/CH/mpegts' },
  transcode: { encoder: 'h264_nvenc', hwDecode: true, gpu: 1, resolution: '720p' },
  hls: HLS
}, outDir)
assert.ok(gpuFull.indexOf('-hwaccel') < gpuFull.indexOf('-i'), '-hwaccel precedes its -i')
assert.ok(gpuFull.indexOf('-hwaccel_device') < gpuFull.indexOf('-i'), '-hwaccel_device precedes its -i')
assert.ok(gpuFull.indexOf('-gpu') > gpuFull.indexOf('-i'), '-gpu is an OUTPUT option')
assert.ok(gpuFull.includes('scale_cuda=-2:720'))
// The slate forces `copy`, so a slated channel must never carry GPU decode flags.
assert.deepStrictEqual(hwDecodeArgs({ encoder: 'copy', hwDecode: true }, { kind: 'file', path: 'slate-720p-h264-aac.ts' }), [],
  'slated channels (forced copy) stay off the GPU')

// Validation: auto is harmless everywhere, explicit requests are NVENC-only.
assert.strictEqual(normalizeTranscode({}).hwDecode, 'auto', 'auto is the default')
assert.strictEqual(normalizeTranscode({}).gpu, null)
assert.strictEqual(normalizeTranscode({ encoder: 'h264_nvenc', hwDecode: true }).hwDecode, true)
assert.strictEqual(normalizeTranscode({ encoder: 'h264_nvenc', gpu: '1' }).gpu, 1, 'numeric-string gpu coerced')
throws(() => normalizeTranscode({ hwDecode: 'yes' }), /hwDecode/)
throws(() => normalizeTranscode({ encoder: 'libx264', hwDecode: true }), /NVENC only/)
throws(() => normalizeTranscode({ encoder: 'copy', hwDecode: true }), /NVENC only/)
throws(() => normalizeTranscode({ encoder: 'libx264', gpu: 0 }), /NVENC only/)
throws(() => normalizeTranscode({ encoder: 'h264_nvenc', gpu: 16 }), /transcode.gpu/)
throws(() => normalizeTranscode({ encoder: 'h264_nvenc', gpu: -1 }), /transcode.gpu/)
// 'auto' must survive on a CPU encoder rather than being rejected — it is the default that
// every existing channel already carries.
assert.strictEqual(normalizeTranscode({ encoder: 'libx264' }).hwDecode, 'auto')

// Resolving 'auto' against the host probe. Pure, so a stubbed probe behaves exactly like a
// real one — the reason this is a function taking caps rather than a peek at cached state.
const CUDA_OK = { hwDecode: { cuda: { verified: true } } }
const CUDA_NO = { hwDecode: { cuda: { verified: false, error: 'no CUVID' } } }
assert.strictEqual(resolveHwDecode({ encoder: 'h264_nvenc' }, CUDA_OK), true, 'auto + capable host = on')
assert.strictEqual(resolveHwDecode({ encoder: 'h264_nvenc' }, CUDA_NO), false, 'auto + incapable host = off')
assert.strictEqual(resolveHwDecode({ encoder: 'h264_nvenc' }, null), false, 'auto + unprobed host = off (safe default)')
assert.strictEqual(resolveHwDecode({ encoder: 'h264_nvenc', hwDecode: true }, CUDA_NO), true,
  'an EXPLICIT true is honoured here — start() is what refuses an incapable host, not this')
assert.strictEqual(resolveHwDecode({ encoder: 'h264_nvenc', hwDecode: false }, CUDA_OK), false, 'explicit off stays off')
assert.strictEqual(resolveHwDecode({ encoder: 'libx264' }, CUDA_OK), false, 'auto on a CPU encoder is always off')
assert.strictEqual(resolveHwDecode({ encoder: 'copy' }, CUDA_OK), false, 'copy decodes nothing')
assert.strictEqual(resolveHwDecode(null, CUDA_OK), false, 'no transcode = libx264 default = off')

// The fallback trigger: these are the REAL stderr lines an RTX 4090 emitted when CUVID
// declined a High 10 source. ffmpeg substitutes the software decoder without a word, so
// the failure surfaces at the filter graph — matching only decoder-shaped errors would
// miss it entirely and leave the channel respawning into the same wall forever.
for (const line of [
  "Impossible to convert between the formats supported by the filter 'graph 0 input from stream 0:0' and the filter 'auto_scale_0'",
  'Failed to inject frame into filter network: Function not implemented',
  'Error while filtering: Function not implemented',
  '[h264 @ 0x55] Failed setup for format cuda: hwaccel initialisation returned error'
]) assert.ok(HW_DECODE_FAIL_RE.test(line), 'must trigger CPU fallback: ' + line)
// Ordinary flaky-source noise must NOT demote a channel off the GPU.
for (const line of [
  'Error while decoding stream #0:0: Invalid data found when processing input',
  "[hls @ 0x55] Skip ('#EXT-X-VERSION:3')",
  'Connection to tcp://origin:81 failed: Connection refused',
  'No capable devices found' // the 8-bit/pixel-format error — a CPU-path problem
]) assert.ok(!HW_DECODE_FAIL_RE.test(line), 'must NOT trigger fallback: ' + line)
log('R: GPU decode path (scale_cuda, pinning, arg ordering, validation, fallback signatures) ✓')

// ===== W: the ffmpeg RSS cap has to know whether the channel transcodes =====
// ⚠ FOUND ON REAL HARDWARE, not here: the first GPU channel showed restarts == memRecycles,
// recycling every ~30 s. The 150 MB default is correct for a `copy` channel (13-30 MB
// remuxing) but a transcoding channel legitimately holds 233 MB with GPU decode and 439 MB
// with CPU decode on a live 1080p source. One global number cannot serve both, and the
// tighter one silently makes transcoding unusable while looking like a healthy watchdog.
const CFG = { ffmpegMaxRssMb: 150, ffmpegMaxRssTranscodeMb: 900 }
assert.strictEqual(rssCapMb({ transcode: { encoder: 'copy' } }, CFG), 150, 'copy keeps the tight remux cap')
assert.strictEqual(rssCapMb({}, CFG), 900, 'no transcode block = libx264 default = transcoding')
assert.strictEqual(rssCapMb({ transcode: { encoder: 'libx264' } }, CFG), 900)
assert.strictEqual(rssCapMb({ transcode: { encoder: 'h264_nvenc' } }, CFG), 900)
assert.strictEqual(rssCapMb({ transcode: { encoder: 'hevc_nvenc' } }, CFG), 900)
// 0 disables the whole mechanism and must stay disabled.
assert.strictEqual(rssCapMb({ transcode: { encoder: 'h264_nvenc' } }, { ffmpegMaxRssMb: 0, ffmpegMaxRssTranscodeMb: 900 }), 0,
  'FFMPEG_MAX_RSS_MB=0 disables the cap for every channel')
// An operator who raises the base above the floor means it — never lower their number.
assert.strictEqual(rssCapMb({ transcode: { encoder: 'h264_nvenc' } }, { ffmpegMaxRssMb: 2000, ffmpegMaxRssTranscodeMb: 900 }), 2000,
  'an explicit base above the floor wins')
log('W: RSS cap is encoder-aware (copy stays tight, transcode gets headroom) ✓')

// ===== V: 24/7 stability, timestamp base, and HTTP source access =====
// CFR: a variable-frame-rate source segments unevenly and players stutter at the joins.
assert.ok(encodeArgs({ encoder: 'libx264', fpsMode: 'cfr' }, HLS).includes('-fps_mode'), 'cfr forces constant frame rate')
assert.ok(!encodeArgs({ encoder: 'libx264' }, HLS).includes('-fps_mode'), 'source frame rate is the default')
throws(() => normalizeTranscode({ encoder: 'copy', fpsMode: 'cfr' }), /copy/)
throws(() => normalizeTranscode({ fpsMode: 'vfr' }), /fpsMode/)
// "Too many packets buffered for output stream" is an ABORT, not a warning.
assert.deepStrictEqual(encodeArgs({ maxMuxQueue: 2048 }, HLS).slice(-2).length, 2)
assert.ok(encodeArgs({ maxMuxQueue: 2048 }, HLS).includes('-max_muxing_queue_size'))
assert.strictEqual(normalizeTranscode({ maxMuxQueue: 2048 }).maxMuxQueue, 2048)
throws(() => normalizeTranscode({ maxMuxQueue: 10 }), /maxMuxQueue/)
// Audio drift: the failure nobody sees until hours in, because every segment is fine.
assert.ok(encodeArgs({ audioSync: true }, HLS).join(' ').includes('aresample=async=1'), 'drift correction applied')
assert.ok(!encodeArgs({}, HLS).includes('-af'), 'no audio filter by default')
throws(() => normalizeTranscode({ audioCodec: 'copy', audioSync: true }), /audioSync/)
// Timestamp base — copyts PRESERVES the source timeline, avoid_negative_ts REWRITES it.
// Both at once is contradictory and ffmpeg picks silently, so validation refuses it.
assert.deepStrictEqual(encodeArgs({ avoidNegativeTs: true }, HLS).filter((a) => a === 'make_zero'), ['make_zero'])
assert.ok(encodeArgs({ copyTs: true }, HLS).includes('-copyts'))
assert.ok(encodeArgs({ copyTs: true }, HLS).includes('-start_at_zero'), 'copyts pairs with start_at_zero')
throws(() => normalizeTranscode({ copyTs: true, avoidNegativeTs: true }), /opposites/)
// HTTP source access. ⚠ These are AVOptions of the http protocol — emitting them for a
// udp/srt/rtmp input makes ffmpeg fail on an unrecognised option, so they must appear on
// the http branch ONLY. That scoping is the whole point of these assertions.
const httpTune = { userAgent: 'Aliran/1.0', headers: 'X-Token: abc\r\n', rwTimeoutMs: 8000 }
const httpArgs = inputArgs({ kind: 'pull', url: 'http://o:81/CH/mpegts' }, httpTune)
assert.ok(httpArgs.includes('-user_agent') && httpArgs.includes('Aliran/1.0'))
assert.ok(httpArgs.includes('-headers') && httpArgs.includes('X-Token: abc\r\n'))
assert.deepStrictEqual(httpArgs.slice(httpArgs.indexOf('-rw_timeout'), httpArgs.indexOf('-rw_timeout') + 2),
  ['-rw_timeout', '8000000'], 'rw_timeout converted to microseconds')
assert.ok(httpArgs.indexOf('-user_agent') < httpArgs.indexOf('-i'), 'source options precede -i')
for (const url of ['udp://239.0.0.1:1234', 'srt://o:9000', 'rtmp://o/app/key']) {
  const a = inputArgs({ kind: 'pull', url }, httpTune)
  assert.ok(!a.includes('-user_agent') && !a.includes('-headers') && !a.includes('-rw_timeout'),
    'http-only options must NOT reach ' + url)
}
assert.ok(!inputArgs({ kind: 'udp', port: 5003, timeoutMs: 10000 }, httpTune).includes('-user_agent'),
  'nor a push listener')
assert.ok(inputArgs({ kind: 'pull', url: 'https://cdn/live/master.m3u8' }, httpTune).includes('-user_agent'),
  'but they DO apply to an HLS pull')
// Operators type headers one per line; ffmpeg needs CRLF-terminated lines.
assert.strictEqual(normalizeIngestTuning({ headers: 'X-A: 1\nX-B: 2' }).headers, 'X-A: 1\r\nX-B: 2\r\n')
throws(() => normalizeIngestTuning({ headers: 'not a header' }), /header/)
throws(() => normalizeIngestTuning({ userAgent: 'a\nb' }), /userAgent/)
throws(() => normalizeIngestTuning({ rwTimeoutMs: 10 }), /rwTimeoutMs/)
log('V: cfr, mux queue, audio drift, timestamp base, HTTP source access (http-scoped) ✓')

// ===== U: HEVC output (hevc_nvenc + libx265) =====
// hevc_nvenc is in the NVENC family, so it must inherit EVERY nvenc rule — the forced-IDR
// that makes HLS segment at all, device pinning, the 8-bit pin, and the CUDA decode path.
// Missing any one of them reproduces a bug already fixed for h264_nvenc.
const hevcGpu = encodeArgs({ encoder: 'hevc_nvenc', hwDecode: true, gpu: 1, resolution: '720p' }, HLS, { kind: 'pull', url: 'http://o/s' })
assert.deepStrictEqual(hevcGpu.slice(0, 10),
  ['-c:v', 'hevc_nvenc', '-preset', 'p2', '-tune', 'll', '-forced-idr', '1', '-gpu', '1'],
  'hevc_nvenc gets forced-idr and device pinning exactly like h264_nvenc')
assert.ok(hevcGpu.includes('scale_cuda=-2:720'), 'and the GPU scaler')
// ⚠ ffmpeg's own HLS muxer asks for this: "Stream HEVC is not hvc1, you should use tag:v
// hvc1 to set it". Without the tag a range of players simply refuse HEVC in HLS — a silent
// no-play on a viewer's device, which is the most expensive kind of bug to chase.
assert.deepStrictEqual(hevcGpu.slice(hevcGpu.indexOf('-tag:v'), hevcGpu.indexOf('-tag:v') + 2), ['-tag:v', 'hvc1'],
  'hevc_nvenc output is tagged hvc1')
assert.ok(encodeArgs({ encoder: 'libx265' }, HLS).includes('hvc1'), 'libx265 output is tagged hvc1 too')
assert.ok(!encodeArgs({ encoder: 'h264_nvenc' }, HLS).includes('-tag:v'), 'h264 needs no tag')
assert.ok(!encodeArgs({ encoder: 'copy' }, HLS).includes('-tag:v'), 'copy must not be re-tagged')
assert.ok(!hevcGpu.includes('-pix_fmt'), 'no -pix_fmt on the GPU path')
assert.ok(encodeArgs({ encoder: 'hevc_nvenc', hwDecode: false }, HLS).includes('-pix_fmt'),
  'CPU path pins 8-bit — hevc_nvenc COULD emit Main10, and a live channel deliberately does not')
assert.deepStrictEqual(hwDecodeArgs({ encoder: 'hevc_nvenc', hwDecode: true }, { kind: 'pull', url: 'http://o/s' }),
  ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], 'hevc_nvenc takes the CUDA decode path too')
assert.strictEqual(resolveHwDecode({ encoder: 'hevc_nvenc' }, CUDA_OK), true, 'auto resolves for hevc_nvenc')
// libx265 is a software encoder: same zerolatency + 8-bit treatment as libx264, no -gpu.
assert.deepStrictEqual(encodeArgs({ encoder: 'libx265', preset: 'quality' }, HLS).slice(0, 8),
  ['-c:v', 'libx265', '-preset', 'slow', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p'])
assert.ok(!encodeArgs({ encoder: 'libx265' }, HLS).includes('-forced-idr'), 'forced-idr is an nvenc option only')
throws(() => normalizeTranscode({ encoder: 'libx265', gpu: 0 }), /NVENC only/)
assert.strictEqual(normalizeTranscode({ encoder: 'hevc_nvenc', gpu: 1 }).gpu, 1, 'hevc_nvenc accepts a device pin')
assert.strictEqual(normalizeTranscode({ encoder: 'libx265' }).encoder, 'libx265')
// The offline slate already knew about HEVC before the encoder existed — a channel whose
// OUTPUT is hevc must get an hevc slate, or the codec change breaks playback mid-playlist.
assert.strictEqual(pickSlateFile({ codec: 'hevc', height: 1080 }), 'slate-1080p-hevc-aac.ts')
assert.strictEqual(pickSlateFile({ codec: 'hevc', height: 720 }), 'slate-720p-hevc-aac.ts')
log('U: HEVC output — nvenc family rules inherited, libx265 software path, hevc slate ✓')

// ===== T: the rest of the demuxer tolerance switches =====
// ⚠ -fflags is ONE option — a second -fflags OVERRIDES the first rather than adding to it,
// so every flag has to end up in a single combined value. Emitting two would silently drop
// whichever came first, and the channel would look configured while behaving as if it were
// not. That is the whole reason these are asserted together.
assert.deepStrictEqual(ingestTuningArgs({ discardCorrupt: true, genPts: true, ignoreDts: true }),
  ['-fflags', '+discardcorrupt+genpts+igndts'], 'all container flags combine into ONE -fflags')
assert.strictEqual(ingestTuningArgs({ discardCorrupt: true, genPts: true }).filter((a) => a === '-fflags').length, 1,
  'never more than one -fflags')
assert.deepStrictEqual(ingestTuningArgs({ genPts: true }), ['-fflags', '+genpts'])
assert.deepStrictEqual(ingestTuningArgs({ ignoreDecodeErrors: true }), ['-err_detect', 'ignore_err'],
  'decoder tolerance is its own option, not an fflag')
assert.deepStrictEqual(ingestTuningArgs({ discardCorrupt: true, ignoreDecodeErrors: true }),
  ['-fflags', '+discardcorrupt', '-err_detect', 'ignore_err'], 'container and decoder switches are independent')
assert.deepStrictEqual(ingestTuningArgs({}), [], 'nothing set = ffmpeg defaults, byte-identical to before')
// They are INPUT options, so they must precede -i or ffmpeg applies them to the output.
const tunedFull = ffmpegArgs({
  input: { kind: 'pull', url: 'http://origin:81/CH/mpegts' },
  ingestTuning: { probesizeKB: 20000, analyzeDurationMs: 15000, threadQueueSize: 1024, discardCorrupt: true, genPts: true, ignoreDecodeErrors: true },
  hls: HLS
}, outDir)
for (const flag of ['-probesize', '-analyzeduration', '-thread_queue_size', '-fflags', '-err_detect']) {
  assert.ok(tunedFull.indexOf(flag) >= 0 && tunedFull.indexOf(flag) < tunedFull.indexOf('-i'), flag + ' precedes -i')
}
assert.strictEqual(normalizeIngestTuning({ genPts: 'yes', ignoreDts: 1, ignoreDecodeErrors: true }).genPts, true,
  'string/number truthiness accepted from a form post')
assert.strictEqual(normalizeIngestTuning({ genPts: 'no' }).genPts, false)
log('T: genpts / igndts / ignore_err — combined fflags, input-side placement ✓')

// ===== S: multi-audio, custom raster, audio format, logo, burn-in subs, CENC =====
// Every filter graph asserted here was run through real ffmpeg 6.1.1 on an RTX 4090
// before being written down — including the two that FAIL there, which is how the
// nv12/alpha rule below was found rather than guessed.

// --- stream mapping. The default stays SILENT so existing channels are byte-identical.
assert.ok(!encodeArgs({ encoder: 'libx264' }, HLS).includes('-map'), 'single-audio default adds no -map at all')
const allAud = encodeArgs({ encoder: 'libx264', audioTracks: 'all' }, HLS)
assert.deepStrictEqual(allAud.slice(0, 4), ['-map', '0:v:0', '-map', '0:a?'],
  'audioTracks:all maps video + EVERY audio track')
// The '?' matters: a video-only source is legitimate and must not be a hard ffmpeg failure.
assert.ok(allAud.includes('0:a?'), 'audio map is optional so a video-only source still runs')

// --- custom raster alongside the presets
assert.deepStrictEqual(parseResolution('720p'), { h: 720 })
assert.deepStrictEqual(parseResolution('1280x720'), { w: 1280, h: 720 })
assert.strictEqual(parseResolution('source'), null)
assert.strictEqual(parseResolution('nonsense'), null)
assert.ok(encodeArgs({ encoder: 'libx264', resolution: '720p' }, HLS).includes('scale=-2:720'),
  'a preset scales by height and keeps the aspect (-2)')
assert.ok(encodeArgs({ encoder: 'libx264', resolution: '1280x720' }, HLS).includes('scale=1280:720'),
  'an explicit WxH is taken literally')
assert.ok(encodeArgs({ encoder: 'h264_nvenc', hwDecode: true, resolution: '1280x720' }, HLS, { kind: 'pull', url: 'http://o/s' })
  .includes('scale_cuda=1280:720'), 'custom raster works on the GPU scaler too')
throws(() => normalizeTranscode({ resolution: '1281x720' }), /even/) // H.264 chroma subsampling
throws(() => normalizeTranscode({ resolution: '1280x721' }), /even/)
throws(() => normalizeTranscode({ resolution: '10x10' }), /160-7680|90-4320/)
throws(() => normalizeTranscode({ resolution: '99999x720' }), /resolution/)
assert.strictEqual(normalizeTranscode({ resolution: '1280x720' }).resolution, '1280x720')

// --- audio format
assert.deepStrictEqual(encodeArgs({ encoder: 'libx264' }, HLS).slice(-6),
  ['-c:a', 'aac', '-ar', '48000', '-b:a', '128k'], 'audio defaults unchanged')
assert.deepStrictEqual(encodeArgs({ encoder: 'libx264', audioCodec: 'opus', audioSampleRate: 44100, audioChannels: 2 }, HLS).slice(-8),
  ['-c:a', 'opus', '-ar', '44100', '-b:a', '128k', '-ac', '2'])
assert.deepStrictEqual(encodeArgs({ encoder: 'libx264', audioCodec: 'copy' }, HLS).slice(-2), ['-c:a', 'copy'],
  'audio copy takes no bitrate/rate/channel options')
throws(() => normalizeTranscode({ audioCodec: 'flac' }), /audioCodec/)
throws(() => normalizeTranscode({ audioSampleRate: 32000 }), /audioSampleRate/)
throws(() => normalizeTranscode({ audioChannels: 3 }), /audioChannels/)
throws(() => normalizeTranscode({ audioTracks: 'both' }), /audioTracks/)

// --- burn-in subtitles. On the GPU the frames must come back to system memory for libass
// and go back up afterwards; skipping that is the "Impossible to convert" failure again.
const subCpu = videoChain({ encoder: 'libx264', resolution: '720p', subtitles: { path: '/s/a.srt' } }, false)
assert.strictEqual(subCpu.complex, null, 'no logo = simple -vf chain')
assert.strictEqual(subCpu.vf, "scale=-2:720,subtitles=filename='/s/a.srt'")
const subGpu = videoChain({ encoder: 'h264_nvenc', resolution: '720p', subtitles: { path: '/s/a.srt' } }, true)
assert.strictEqual(subGpu.vf,
  "scale_cuda=-2:720,hwdownload,format=nv12,subtitles=filename='/s/a.srt',format=yuv420p,hwupload_cuda",
  'GPU + subtitles round-trips through system memory')
// A Windows path hits filter-graph escaping from three directions at once.
assert.ok(videoChain({ subtitles: { path: 'C:\\subs\\a b.srt' } }, false).vf
  .includes("subtitles=filename='C\\:\\\\subs\\\\a b.srt'"), 'drive letter, backslashes and spaces all escaped')

// --- logo. A second input means filter_complex + explicit maps.
// ⚠ overlay_cuda must NEVER appear in a graph. It SEGFAULTS ffmpeg 6.1.1 on driver
// 580.159.03 in every configuration tested (opaque/transparent logo, looped/single-shot
// input, literal/expression anchors), and a crashing filter on a live channel is a respawn
// loop rather than a slow channel. It also cannot blend alpha at all — it only accepts
// nv12. This assertion is the guard against someone "optimising" the CPU composite away.
const logoGpu = videoChain({ encoder: 'h264_nvenc', resolution: '720p', logo: { path: '/l.png', corner: 'tr', marginPx: 20 } }, true)
assert.ok(!logoGpu.complex.includes('overlay_cuda'), 'overlay_cuda segfaults this ffmpeg — never emit it')
assert.ok(logoGpu.complex.includes('hwdownload'), 'GPU frames come back to system memory to composite')
assert.ok(logoGpu.complex.includes('format=rgba'), 'rgba so a transparent logo actually blends')
assert.ok(logoGpu.complex.includes('hwupload_cuda'), 'and return to the card for nvenc')
assert.ok(logoGpu.complex.indexOf('hwdownload') < logoGpu.complex.indexOf('hwupload_cuda'), 'download before upload')
const logoCpu = videoChain({ encoder: 'libx264', resolution: '720p', logo: { path: '/l.png', corner: 'tr', marginPx: 20 } }, false)
assert.ok(!logoCpu.complex.includes('hwdownload') && !logoCpu.complex.includes('hwupload'),
  'the CPU path needs no hardware round trip at all')
// Corner anchors are EXPRESSIONS so they survive a source raster change.
for (const [corner, xy] of [['tl', 'x=20:y=20'], ['tr', 'x=W-w-20:y=20'], ['bl', 'x=20:y=H-h-20'], ['br', 'x=W-w-20:y=H-h-20']]) {
  assert.ok(videoChain({ logo: { path: '/l.png', corner, marginPx: 20 } }, false).complex.includes('overlay=' + xy), corner)
}
assert.ok(videoChain({ logo: { path: '/l.png', heightPx: 64 } }, false).complex.includes('scale=-1:64'), 'logo can be resized')
// vaapi cannot take system-memory frames either, so the composite has to be uploaded for it
// too — the same rule as nvenc, just a different upload filter.
assert.ok(videoChain({ encoder: 'h264_vaapi', logo: { path: '/l.png' } }, false).complex.endsWith('format=nv12,hwupload[vout]'),
  'a composited vaapi frame is uploaded before the encoder sees it')
// The logo becomes input 1, and the graph output has to be mapped by name.
const logoArgs = encodeArgs({ encoder: 'libx264', logo: { path: '/l.png' }, audioTracks: 'all' }, HLS)
assert.strictEqual(logoArgs[0], '-filter_complex')
assert.deepStrictEqual(logoArgs.slice(2, 6), ['-map', '[vout]', '-map', '0:a?'], 'filter output + all audio mapped')
assert.ok(!logoArgs.includes('-vf'), 'filter_complex replaces -vf, never both')
assert.deepStrictEqual(logoInputArgs({ logo: { path: '/l.png' } }), ['-i', '/l.png'])
assert.deepStrictEqual(logoInputArgs({}), [])
const fullLogo = ffmpegArgs({ input: { kind: 'pull', url: 'http://o/s' }, transcode: { encoder: 'libx264', logo: { path: '/l.png' } }, hls: HLS }, outDir)
assert.ok(fullLogo.indexOf('/l.png') > fullLogo.indexOf('http://o/s'), 'the logo is input 1, after the source')
assert.ok(fullLogo.indexOf('-filter_complex') > fullLogo.indexOf('/l.png'), 'the graph follows the input it references')

// ⚠ REGRESSION: the `test` input is TWO ffmpeg inputs (lavfi video + lavfi tone), so a
// logo added after it is input 2 and the tone is input 1. Hardcoding [1:v] made ffmpeg
// reject the whole graph — "Stream specifier ':v' ... matches no streams" — and the channel
// never started. Every unit test here used a single-input source, so only running the real
// broadcaster caught it. These assertions are the guard.
assert.strictEqual(mainInputCount({ kind: 'test' }), 2, 'test = lavfi video + lavfi tone')
assert.strictEqual(mainInputCount({ kind: 'pull', url: 'http://o/s' }), 1)
assert.strictEqual(mainInputCount({ kind: 'file', path: '/m/a.mp4' }), 1)
assert.strictEqual(mainInputCount('test'), 2, 'legacy string input counted too')
const logoOnTest = videoChain({ logo: { path: '/l.png' } }, false, { kind: 'test' })
assert.ok(logoOnTest.complex.startsWith('[2:v]'), 'logo is input 2 after a test source')
assert.ok(logoOnTest.complex.includes('[0:v]'), 'and the picture is still input 0')
const logoOnPull = videoChain({ logo: { path: '/l.png' } }, false, { kind: 'pull', url: 'http://o/s' })
assert.ok(logoOnPull.complex.startsWith('[1:v]'), 'logo is input 1 after a single-input source')
// The audio map has to follow the same arithmetic or a test channel loses its tone.
assert.deepStrictEqual(encodeArgs({ logo: { path: '/l.png' } }, HLS, { kind: 'test' }).slice(2, 6),
  ['-map', '[vout]', '-map', '1:a:0?'], 'test audio comes from input 1')
assert.deepStrictEqual(encodeArgs({ logo: { path: '/l.png' } }, HLS, { kind: 'pull', url: 'http://o/s' }).slice(2, 6),
  ['-map', '[vout]', '-map', '0:a:0?'], 'pull audio shares input 0')
assert.deepStrictEqual(encodeArgs({ audioTracks: 'all' }, HLS, { kind: 'test' }).slice(0, 4),
  ['-map', '0:v:0', '-map', '1:a?'], 'multi-audio on a test source maps the tone input')
// End to end: the logo -i must sit between the source inputs and the graph referencing it.
const testFull = ffmpegArgs({ input: { kind: 'test' }, transcode: { logo: { path: '/l.png' } }, hls: HLS }, outDir)
assert.strictEqual(testFull.filter((a) => a === '-i').length, 3, 'test + logo = three -i')
assert.ok(testFull.lastIndexOf('-i') < testFull.indexOf('-filter_complex'), 'all inputs precede the graph')

// --- validation: drawing on a picture that is never decoded is refused, not ignored
throws(() => normalizeTranscode({ encoder: 'copy', logo: { path: '/l.png' } }), /copy/)
throws(() => normalizeTranscode({ encoder: 'copy', subtitles: { path: '/a.srt' } }), /copy/)
throws(() => normalizeTranscode({ logo: { path: '' } }), /logo.path/)
throws(() => normalizeTranscode({ logo: { path: '/l.png', corner: 'middle' } }), /corner/)
throws(() => normalizeTranscode({ subtitles: { path: 'x\ny' } }), /subtitles.path/)
assert.strictEqual(normalizeTranscode({ logo: null }).logo, null, 'null clears the logo')
assert.strictEqual(normalizeTranscode({ logo: { path: '/l.png' } }).logo.corner, 'tr')
assert.strictEqual(normalizeTranscode({ logo: { path: '/l.png' } }).logo.marginPx, 20)

// --- CENC key for encrypted DASH
const enc = normalizeInput({ kind: 'pull', url: 'https://o/m.mpd', cencKey: '00112233445566778899AABBCCDDEEFF' }, { config: cfg })
assert.strictEqual(enc.cencKey, '00112233445566778899aabbccddeeff', 'hex key normalised to lower case')
assert.deepStrictEqual(inputArgs(enc), [...RC, '-cenc_decryption_key', '00112233445566778899aabbccddeeff', '-i', 'https://o/m.mpd'])
assert.ok(inputArgs(enc).indexOf('-cenc_decryption_key') < inputArgs(enc).indexOf('-i'), 'a demuxer option must precede -i')
throws(() => normalizeInput({ kind: 'pull', url: 'https://o/m.mpd', cencKey: 'nothex' }, { config: cfg }), /cencKey/)
throws(() => normalizeInput({ kind: 'pull', url: 'https://o/m.mpd', cencKey: 'aabb' }, { config: cfg }), /cencKey/)
assert.strictEqual(normalizeInput({ kind: 'pull', url: 'https://o/m.mpd' }, { config: cfg, existing: enc }).cencKey,
  enc.cencKey, 'omitted on a PATCH = keep the stored key')
assert.strictEqual(normalizeInput({ kind: 'pull', url: 'https://o/m.mpd', cencKey: '' }, { config: cfg, existing: enc }).cencKey,
  undefined, 'empty string clears it')
// A .mpd pull is LIVE by default, exactly like .m3u8 — no -re.
assert.ok(!inputArgs({ kind: 'pull', url: 'https://o/m.mpd' }).includes('-re'), 'dash manifest is not paced with -re')
log('S: multi-audio, custom raster, audio format, logo overlay, burn-in subs, CENC key ✓')

log('\nRESULT: PASS ✅  (S15a args table + input/transcode validation + backup sources + incident correlation + offline slate + resume pacing + gpu decode path + overlays/audio/CENC)')
