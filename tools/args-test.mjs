// Pure-function tests for the S15a broadcaster ingest engine: ffmpeg argument
// builders (hls.js) and input/transcode validation (channel.js). No ffmpeg, no
// network, no disk — safe anywhere. npm run test:args
import assert from 'assert'
import path from 'path'
import {
  ffmpegArgs, inputArgs, encodeArgs, hwDeviceArgs, hlsMuxArgs,
  upgradeInputString, TRANSCODE_DEFAULTS
} from '../broadcaster/src/hls.js'
import {
  ControlError, normalizeInput, normalizeTranscode, randomStreamKey,
  isPushInput, pushUrl, pickSource
} from '../broadcaster/src/channel.js'

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
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'https://cdn/live/master.m3u8' }),
  ['-allowed_extensions', 'ALL', '-i', 'https://cdn/live/master.m3u8'], 'live HLS: no -re, SSAI-tolerant')
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'https://cdn/live/MASTER.M3U8?token=x' }),
  ['-allowed_extensions', 'ALL', '-i', 'https://cdn/live/MASTER.M3U8?token=x'])
assert.deepStrictEqual(inputArgs({ kind: 'pull', url: 'https://cdn/vod/movie.mp4' }),
  ['-re', '-i', 'https://cdn/vod/movie.mp4'], 'http VOD: -re')
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
assert.deepStrictEqual(encodeArgs({ encoder: 'h264_nvenc', preset: 'balanced', videoBitrateKbps: 2500, fps: 30, resolution: '720p' }, HLS), [
  '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll',
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
  '-r', '30', '-vf', 'scale=-2:720',
  '-c:a', 'aac', '-ar', '48000', '-b:a', '128k'])
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
log('E: string auto-upgrade + scheme whitelist ✓')

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

log('\nRESULT: PASS ✅  (S15a args table + input/transcode validation + backup sources)')
