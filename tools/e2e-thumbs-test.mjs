// End-to-end test for the rolling live thumbnail (broadcaster half).
//
// A channel's feed drive is the ONE store whose growth law already matches "constantly
// replaced, bounded history": the live HLS window, which mirrorDirToDrive clears below the
// live edge. The thumbnail is one more small rolling file riding that machinery — and
// "riding it" is a claim, not a fact, so this lane proves it rather than assuming it.
//
//   A  PURE  — the knob precedence (THUMBS kill switch / per-channel opt-in / copy-channel
//      default-off) and the guarantee that thumbnail args cannot perturb the segment output.
//   B  LIVE  — a running test-pattern channel puts /thumb.jpg in its feed drive: JPEG magic
//      bytes, and ffprobe agrees it is a 320px mjpeg.
//   C  ROLLS — over several refresh cycles the bytes actually CHANGE.
//   D  BOUNDED — ⚠ THE LOAD-BEARING ONE. Each superseded thumbnail's blob blocks are FREED
//      by the existing mirror clear, and the drive's held-block count stays flat over N
//      cycles instead of climbing. If this fails the feature is a slow disk leak on 89
//      channels, so it is asserted two ways: per-entry (exact) and in aggregate (trend).
//   E  OFF   — a channel with `thumb: false` never grows a /thumb.jpg entry at all.
//   F  P2P   — a fresh viewer replicating over the local testnet fetches the thumbnail.
//   G  CPU   — informational: the measured cost of the decode a `copy` channel does not
//      otherwise do. This is the number that made copy channels opt-in.
//   H  AUDIO-ONLY — ⚠ THE OTHER LOAD-BEARING ONE. A source with no video stream must
//      still RUN. The thumbnail output's `-map 0:v:0` is fatal to it (proved here against
//      real ffmpeg), and the failure is not a missing picture: ffmpeg exits before writing
//      a segment, the watchdog respawns into the same failure, and after SLATE_AFTER tries
//      the slate engages — the slate HAS video, so the thumbnail then succeeds and the
//      channel is PINNED TO BARS looking healthy. The gate (hasKnownVideo) is what stops it.
//
// Local DHT testnet (hermetic, like test:epg-p2p). Requires ffmpeg + ffprobe on PATH.
// Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawn, spawnSync } from 'child_process'
import createTestnet from 'hyperdht/testnet.js'
import { ChannelManager, resolveThumb } from '../broadcaster/src/channel.js'
import { ffmpegArgs, thumbArgs, thumbDecodeArgs, THUMB_FILENAME, THUMB_FAIL_RE } from '../broadcaster/src/hls.js'
import { THUMB_PATH } from '../sdk/serve.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(200) }
  throw new Error('timeout: ' + label)
}

// Refresh cadence for the whole lane. 2 s so a dozen cycles fit in half a minute; the
// production default is 30 s and nothing here depends on which it is.
const INTERVAL_S = 2
const CYCLES = 10

const dirs = {
  bc: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ethumb-bc-')),
  work: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ethumb-work-')),
  viewer: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ethumb-view-')),
  cpu: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ethumb-cpu-'))
}
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

// CPU time consumed by a LIVE child process, in seconds. ffmpeg's own -benchmark reports
// this via getrusage and therefore prints nothing but maxrss on Windows, so the number has
// to come from the OS: /proc on Linux (the production host), Get-Process elsewhere. null
// when neither works — section G is informational and must never fail the lane.
function cpuSeconds (pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `try { (Get-Process -Id ${pid} -ErrorAction Stop).CPU } catch { '' }`], { encoding: 'utf8' })
    const v = parseFloat((r.stdout || '').trim())
    return Number.isFinite(v) ? v : null
  }
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')
    return (Number(f[11]) + Number(f[12])) / 100 // utime + stime, clock ticks → seconds
  } catch { return null }
}

// How many blocks of a drive's blob core are still held LOCALLY. This — not core.length,
// which is an append-only counter that must grow — is what costs disk, and what section D
// is really about.
async function heldBlocks (drive) {
  const blobs = await drive.getBlobs()
  let held = 0
  for (let i = 0; i < blobs.core.length; i++) if (await blobs.core.has(i)) held++
  return { held, length: blobs.core.length }
}
async function blobCleared (drive, blob) {
  const blobs = await drive.getBlobs()
  for (let i = blob.blockOffset; i < blob.blockOffset + blob.blockLength; i++) {
    if (await blobs.core.has(i)) return false
  }
  return true
}

try {
  // ===== A. Pure: knob precedence + argv isolation (no ffmpeg, no network) =====
  // ⚠ The broadcaster writes THUMB_FILENAME into the feed and the SDK serves THUMB_PATH out
  // of it; they are declared in two workspaces that never import each other, so nothing but
  // this assertion stops a rename on one side from silently 404ing every grid cell on the
  // other. It is first in the lane on purpose — it is the cheapest and the most total.
  assert.strictEqual(THUMB_PATH, '/' + THUMB_FILENAME,
    `the SDK's served path and the broadcaster's written filename must agree (${THUMB_PATH} vs ${THUMB_FILENAME})`)

  const cfgOn = { thumbs: { enabled: true, intervalSeconds: 30, width: 320, quality: 7 } }
  const cfgOff = { thumbs: { enabled: false, intervalSeconds: 30, width: 320, quality: 7 } }
  const cfgNoDefault = { thumbs: { enabled: true, intervalSeconds: 0, width: 320, quality: 7 } }
  // `test` inputs throughout: the knob precedence is what section A is about, and every
  // resolveThumb call has to clear the video gate first (see section H / args-test X2).
  const transcoding = { input: { kind: 'test' }, transcode: { encoder: 'libx264' } }
  const passthrough = { input: { kind: 'test' }, transcode: { encoder: 'copy' } }

  assert.ok(resolveThumb(transcoding, cfgOn), 'a transcoding channel follows the fleet default (on)')
  assert.strictEqual(resolveThumb(passthrough, cfgOn), null, 'a copy channel is NOT on by default (it would decode)')
  assert.ok(resolveThumb({ ...passthrough, thumb: true }, cfgOn), 'a copy channel opts in explicitly')
  assert.strictEqual(resolveThumb({ ...transcoding, thumb: false }, cfgOn), null, 'per-channel opt-out wins over the fleet default')
  assert.strictEqual(resolveThumb({ ...transcoding, thumb: true }, cfgOff), null, 'THUMBS=0 overrides even an explicit per-channel opt-in')
  assert.strictEqual(resolveThumb(transcoding, cfgNoDefault), null, 'THUMB_INTERVAL_SECONDS=0 turns the fleet default off')
  assert.strictEqual(resolveThumb({ ...transcoding, thumb: true }, cfgNoDefault).intervalSeconds, 30,
    'an opt-in under a 0 fleet interval falls back to the built-in 30 s')
  assert.strictEqual(resolveThumb(transcoding, cfgOn).intervalSeconds, 30, 'the fleet interval is carried through')
  log('A: knob precedence — THUMBS kill switch > per-channel thumb > copy-default-off > fleet interval ✓')

  // The segment output must be BYTE-IDENTICAL with thumbnails on. This runs in the same
  // ffmpeg process as 89 live channels; an option that leaked onto the media output would
  // be a fleet-wide incident, not a cosmetic bug.
  const hls = { time: 2, listSize: 6 }
  const baseArgs = ffmpegArgs({ input: { kind: 'test' }, hls }, '/out')
  const thumbedArgs = ffmpegArgs({ input: { kind: 'test' }, hls, thumb: { intervalSeconds: 30, width: 320, quality: 7 } }, '/out')
  assert.deepStrictEqual(thumbedArgs.slice(0, baseArgs.length), baseArgs,
    'the thumbnail output is appended AFTER the segment output, changing nothing before it')
  assert.deepStrictEqual(thumbedArgs.slice(baseArgs.length), thumbArgs({ intervalSeconds: 30, width: 320, quality: 7 }, '/out'),
    'everything added is the thumbnail output itself')
  assert.deepStrictEqual(ffmpegArgs({ input: { kind: 'test' }, hls, thumb: null }, '/out'), baseArgs,
    'a channel with thumbnails off spawns the exact argv it always did')
  // The copy path additionally gains the decoder hint — as an INPUT option, and only there.
  const copyBase = ffmpegArgs({ input: { kind: 'pull', url: 'http://h/x' }, transcode: { encoder: 'copy' }, hls }, '/out')
  const copyThumbed = ffmpegArgs({ input: { kind: 'pull', url: 'http://h/x' }, transcode: { encoder: 'copy' }, hls, thumb: { intervalSeconds: 30 } }, '/out')
  // ⚠ The hint is INSERTED into the argv; it does not lead it. `-y` does (the image2
  // overwrite guard — see ffmpegArgs). Anchor on the flag rather than a fixed offset, so the
  // next leading global cannot silently re-point these assertions at the wrong words: that is
  // exactly what the `-y` hotfix did to the two `slice(0, 2)` / `slice(2, …)` calls here.
  const skipAt = copyThumbed.indexOf('-skip_frame')
  assert.strictEqual(copyThumbed[0], '-y', 'the overwrite guard still leads the argv')
  assert.deepStrictEqual(copyThumbed.slice(skipAt, skipAt + 2), ['-skip_frame', 'nokey'], 'copy + thumbnail decodes keyframes only')
  assert.ok(skipAt > 0 && skipAt < copyThumbed.indexOf('-i'), '-skip_frame is a decoder option, so it precedes -i')
  // Drop the two hint words and what is left still OPENS with the untouched media argv.
  const copyMedia = [...copyThumbed.slice(0, skipAt), ...copyThumbed.slice(skipAt + 2)]
  assert.deepStrictEqual(copyMedia.slice(0, copyBase.length), copyBase, 'the copy channel keeps its exact media argv')
  assert.strictEqual(thumbDecodeArgs({ encoder: 'libx264' }, { intervalSeconds: 30 }, { kind: 'pull', url: 'http://h/x' }).length, 0,
    '-skip_frame is NEVER applied to a transcoding channel (it would reduce the channel to keyframes)')
  assert.strictEqual(thumbDecodeArgs({ encoder: 'copy' }, { intervalSeconds: 30 }, { kind: 'test' }).length, 0,
    'lavfi has no bitstream to skip into')
  log('A: argv isolation — segment output byte-identical, -skip_frame confined to copy ✓')

  // ===== Broadcaster over a local DHT testnet =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const manager = new ChannelManager({
    dataDir: dirs.bc,
    workDir: dirs.work,
    panelPubKey: null, // no panel → PanelLink registration is a no-op
    publisherKey: null,
    bootstrap: testnet.bootstrap,
    feedBuffer: 'disk',
    // 1 s segments so the live window fills fast and rotation churn is visible inside the
    // lane's runtime; the thumbnail refreshes faster than the window rolls, which is the
    // stressful ordering for the clear path.
    hls: { time: 1, listSize: 6 },
    feedRotate: { hours: 0, treeMb: 0, graceMs: 2000 },
    thumbs: { enabled: true, intervalSeconds: INTERVAL_S, width: 320, quality: 7 }
  })
  await manager.init(); cleanups.push(() => manager.close())

  const on = await manager.add('thumbon', { title: 'Thumbs On', input: { kind: 'test' } })
  await manager.add('thumboff', { title: 'Thumbs Off', input: { kind: 'test' }, thumb: false })
  assert.strictEqual((await manager.get('thumbon')).thumbs.interval, INTERVAL_S, 'status reports the resolved interval')
  assert.strictEqual((await manager.get('thumboff')).thumbs.interval, null, 'an opted-out channel reports no interval')
  await manager.start('thumbon')
  await manager.start('thumboff')
  const driveOn = manager.channels.get('thumbon').run.drive
  const driveOff = manager.channels.get('thumboff').run.drive
  log(`testnet up; channels started (feed ${on.feedKey.slice(0, 12)}…, ${INTERVAL_S}s refresh)`)

  // ===== B. The thumbnail lands in the feed drive as real JPEG =====
  await waitFor(async () => (await manager.get('thumbon')).playlist, 40000, 'the channel to publish a playlist')
  const firstEntry = await waitFor(() => driveOn.entry('/' + THUMB_FILENAME), 40000, '/thumb.jpg to appear in the feed drive')
  const firstBytes = await driveOn.get('/' + THUMB_FILENAME)
  assert.ok(firstBytes && firstBytes.length > 0, '/thumb.jpg has bytes')
  assert.strictEqual(b4a.toString(firstBytes.subarray(0, 3), 'hex'), 'ffd8ff', 'JPEG magic bytes (FF D8 FF)')
  const jpgPath = path.join(dirs.cpu, 'probe.jpg')
  fs.writeFileSync(jpgPath, firstBytes)
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', jpgPath], { encoding: 'utf8' })
  const probed = (probe.stdout || '').trim()
  assert.match(probed, /^mjpeg,320,/, `ffprobe sees a 320px mjpeg (got "${probed}")`)
  log(`B: /thumb.jpg present — ${firstBytes.length} bytes, ffprobe "${probed}" ✓`)

  // ⚠ LOAD-BEARING for the video gate, not for the picture: thumbnails only attach once a
  // channel's video is POSITIVELY known (hasKnownVideo), and the only general source of
  // that knowledge is ffmpeg's own banner. If the learned profile stayed in memory, every
  // broadcaster restart would forget it and no non-`test` channel would ever carry a
  // thumbnail again — the feature would work in this lane and nowhere in production.
  const reg = JSON.parse(fs.readFileSync(path.join(dirs.bc, 'channels.json'), 'utf8'))
  assert.ok(reg.thumbon && reg.thumbon.detectedProfile && reg.thumbon.detectedProfile.width > 0,
    'the profile scraped from ffmpeg\'s banner is PERSISTED to channels.json, so it survives a restart')
  log(`B: detectedProfile persisted — ${JSON.stringify(reg.thumbon.detectedProfile)} ✓`)

  // ===== C + D. It rolls, and every superseded version's blocks are freed =====
  // Both are sampled in one loop because they are the same event seen twice: a refresh is a
  // put of new bytes AND a clear of the old ones, and the second half is the part that
  // decides whether this feature is bounded or a leak.
  const versions = [{ blob: firstEntry.value.blob, bytes: firstBytes }]
  const heldSeries = []
  const settle = await heldBlocks(driveOn)
  heldSeries.push(settle.held)
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const prev = versions[versions.length - 1]
    const next = await waitFor(async () => {
      const e = await driveOn.entry('/' + THUMB_FILENAME)
      if (!e || e.value.blob.blockOffset === prev.blob.blockOffset) return null
      const bytes = await driveOn.get('/' + THUMB_FILENAME)
      return bytes && bytes.length ? { blob: e.value.blob, bytes } : null
    }, (INTERVAL_S + 8) * 1000, `thumbnail refresh #${cycle + 1}`)
    versions.push(next)
    // The exact claim: the mirror's supersede-then-clearBlob path freed the OLD blob.
    assert.ok(await blobCleared(driveOn, prev.blob),
      `refresh #${cycle + 1} freed the superseded thumbnail's blob blocks`)
    const s = await heldBlocks(driveOn)
    heldSeries.push(s.held)
  }
  const changed = versions.filter((v, i) => i > 0 && !v.bytes.equals(versions[i - 1].bytes)).length
  assert.ok(changed >= 2, `the picture actually changes between refreshes (${changed}/${versions.length - 1} differed)`)
  assert.ok(versions.every((v) => b4a.toString(v.bytes.subarray(0, 3), 'hex') === 'ffd8ff'), 'every refresh is a valid JPEG')
  log(`C: ${versions.length} thumbnails over ${CYCLES} cycles, ${changed} byte-changes ✓`)

  // Aggregate trend. `length` is the append-only block counter and MUST grow; `held` is
  // local disk, and it is the one that must not. The bound is generous on purpose — the
  // live window itself breathes as segments rotate — because the failure this catches is
  // monotonic growth, not jitter.
  //
  // ⚠ The slack is sized from the FIXTURE, not picked: one 1 s segment of 720p30 testsrc2
  // is ~8-10 of these 64 KB blocks, and a sample taken between a segment landing and the
  // rotation that retires it legitimately counts one extra (observed: a lone 82 in an
  // otherwise flat 72 series, which a one-segment bound failed). Two segments plus a
  // thumbnail is the widest honest transient. It stays a real assertion because the leak
  // this exists to catch is UNBOUNDED: 10 refreshes of an un-freed thumbnail is ~30 blocks
  // and climbing, and a leaking live window is hundreds. The exact claim — every superseded
  // thumbnail's blob is freed — is asserted per refresh above (blobCleared), not here.
  const SLACK = 24
  const final = await heldBlocks(driveOn)
  const early = Math.max(...heldSeries.slice(0, 3))
  const late = Math.max(...heldSeries.slice(-3))
  log(`D: blob core grew ${settle.length} → ${final.length} blocks (append-only, expected); ` +
      `HELD blocks ${heldSeries.join(' ')} (early max ${early}, late max ${late})`)
  assert.ok(await blobCleared(driveOn, versions[0].blob), 'the very first thumbnail is long gone from local storage')
  assert.ok(late <= early + SLACK, `held blocks stay flat across ${CYCLES} refreshes — old thumbnail blobs ARE freed (early ${early}, late ${late})`)
  assert.ok(final.length > final.held, 'the append-only core is strictly larger than what is still held (reclaim is doing work)')
  log(`D: boundedness holds — ${final.held} of ${final.length} blocks still held after ${CYCLES} refreshes ✓`)

  // ===== E. Opted-out channel never grows the entry =====
  assert.ok((await manager.get('thumboff')).playlist, 'the opted-out channel is genuinely live (so absence means absence)')
  assert.strictEqual(await driveOff.entry('/' + THUMB_FILENAME), null, 'thumb:false produces no /thumb.jpg entry at all')
  assert.strictEqual((await manager.get('thumboff')).thumbs.present, false, 'status reports no thumbnail for an opted-out channel')
  assert.strictEqual((await manager.get('thumbon')).thumbs.present, true, 'status reports the thumbnail for an opted-in channel')
  log('E: thumb:false — no entry, no bytes, status says so ✓')

  // ===== F. A fresh viewer replicates it over the testnet =====
  const vStore = new Corestore(dirs.viewer); await vStore.ready(); cleanups.push(() => vStore.close())
  const replica = new Hyperdrive(vStore, b4a.from(on.feedKey, 'hex'), { encryptionKey: b4a.from(on.encryptionKey, 'hex') })
  await replica.ready()
  const vSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap }); cleanups.push(() => vSwarm.destroy())
  vSwarm.on('connection', (s) => vStore.replicate(s))
  vSwarm.join(replica.discoveryKey, { client: true, server: false })
  const viewerThumb = await waitFor(() => replica.get('/' + THUMB_FILENAME), 60000, 'viewer to replicate /thumb.jpg')
  assert.strictEqual(b4a.toString(viewerThumb.subarray(0, 3), 'hex'), 'ffd8ff', 'the replicated thumbnail is a JPEG')
  log(`F: fresh viewer replicated /thumb.jpg over the testnet — ${viewerThumb.length} bytes ✓`)
  await replica.close()

  // ===== H. A video-less source still RUNS (and never grows a thumbnail) =====
  // Ordered before G so the CPU measurement still runs with an otherwise idle manager.
  const audioOnly = path.join(dirs.cpu, 'audio-only.ts')
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:a', 'aac', '-f', 'mpegts', audioOnly], { encoding: 'utf8' })
  assert.ok(fs.existsSync(audioOnly) && fs.statSync(audioOnly).size > 0, 'audio-only fixture rendered')
  const vProbe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', audioOnly], { encoding: 'utf8' })
  assert.strictEqual((vProbe.stdout || '').trim(), '', 'the fixture genuinely carries no video stream')

  // The failure itself, against real ffmpeg — the gate is only worth its complexity if this
  // is true, and "ffmpeg probably errors" is not a thing to take on trust. Both encoders,
  // because they fail in DIFFERENT places: a transcoding channel dies on `-map 0:v:0`
  // (nothing to map), a `copy` channel dies even earlier on thumbDecodeArgs' -skip_frame
  // (no video decoder to skip into). Neither is survivable and neither is loud about why.
  const runFf = (encoder, thumb) => {
    const out = fs.mkdtempSync(path.join(dirs.cpu, 'audio-'))
    const r = spawnSync('ffmpeg', ['-hide_banner', '-t', '3',
      ...ffmpegArgs({ input: { kind: 'file', path: audioOnly }, transcode: { encoder }, hls: { time: 2, listSize: 6 }, thumb }, out)],
    { encoding: 'utf8', timeout: 60000 })
    try { fs.rmSync(out, { recursive: true, force: true }) } catch {}
    return { code: r.status, stderr: r.stderr || '' }
  }
  const THUMB_SPEC = { intervalSeconds: INTERVAL_S, width: 320, quality: 7 }
  for (const encoder of ['libx264', 'copy']) {
    const withThumb = runFf(encoder, THUMB_SPEC)
    const withoutThumb = runFf(encoder, null)
    assert.notStrictEqual(withThumb.code, 0, `${encoder}: the thumbnail output kills a video-less source (exit ${withThumb.code})`)
    assert.ok(THUMB_FAIL_RE.test(withThumb.stderr),
      `${encoder}: it must fail in a way channel.js can MATCH, so a stale profile costs one respawn instead of a permanent slate — got: ` +
      (withThumb.stderr.trim().split('\n').filter(Boolean).pop() || '(no stderr)'))
    assert.strictEqual(withoutThumb.code, 0,
      `${encoder}: the SAME source muxes fine with no thumbnail output — the second output is the whole cause`)
    log(`   ${encoder}: exit ${withThumb.code} with the thumbnail output, 0 without ✓`)
  }

  // And now the gate, end to end: the fleet default is ON here (transcoding encoder, a
  // positive THUMB_INTERVAL_SECONDS), so nothing but hasKnownVideo keeps this channel alive.
  await manager.add('audioonly', { title: 'Audio Only', input: { kind: 'file', path: audioOnly } })
  assert.strictEqual((await manager.get('audioonly')).thumbs.interval, null,
    'a channel whose video is not positively known reports no thumbnail BEFORE it ever spawns')
  await manager.start('audioonly')
  const driveAudio = manager.channels.get('audioonly').run.drive
  await waitFor(async () => (await manager.get('audioonly')).playlist, 40000, 'the audio-only channel to publish a playlist')
  // Past when a thumbnail would have appeared, and past the first respawns of a crash loop.
  await sleep((INTERVAL_S + 4) * 1000)
  const audioSt = await manager.get('audioonly')
  assert.ok(audioSt.playlist && audioSt.ffmpegUp, 'the audio-only channel is up and STAYING up')
  assert.strictEqual(audioSt.watchdog.restarts, 0, `no crash loop (${audioSt.watchdog.restarts} respawns)`)
  assert.strictEqual(audioSt.slate.slated, false, 'and it never fell through to the slate it could not have left')
  assert.strictEqual(await driveAudio.entry('/' + THUMB_FILENAME), null, 'no /thumb.jpg entry — the output was never attached')
  assert.strictEqual(audioSt.thumbs.interval, null, 'status says so, so a grid host skips the fetch instead of learning it from a 404')
  assert.strictEqual(manager.channels.get('audioonly').detectedProfile, null, 'and no video profile was ever learned from it')
  await manager.stop('audioonly')
  log('H: audio-only source — fatal with the thumbnail output on both encoders; gated off, ' +
      'the channel runs clean: no entry, no respawns, no slate ✓')

  // ===== G. CPU cost of the copy-channel decode (informational) =====
  // The measurement that decided the default. A `copy` channel never decodes; the thumbnail
  // makes it, so this is a real new cost on a box whose whole fleet is passthrough.
  //
  // Three things this got wrong before, all worth keeping written down:
  //   - the live channels above must be STOPPED first; their ffmpeg and swarm churn is
  //     larger than the effect being measured;
  //   - watching a REALTIME-paced channel for 12-20 s cannot resolve a ~0.2 CPU-s delta —
  //     scheduler noise swamped it and produced a negative "saving" twice;
  //   - so measure FIXED WORK instead of a time slice: strip -re and remux a known number
  //     of content-seconds flat out. The signal then scales with content while the noise
  //     does not, and dividing by the content duration converts straight back to
  //     "% of one core at realtime", which is the number the fleet budget is in.
  await manager.stop('thumbon')
  await manager.stop('thumboff')
  log(`G: live channels stopped; measuring the copy-channel decode cost (${INTERVAL_S}s interval)…`)
  const sample = path.join(dirs.cpu, 'sample.ts')
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-f', 'mpegts', sample], { encoding: 'utf8' })
  const CONTENT_S = 600 // content-seconds remuxed per run (~20 s of wall time)
  const ROUNDS = 2
  async function measure (thumb) {
    const out = fs.mkdtempSync(path.join(dirs.cpu, 'run-'))
    // -re paces a `file` input to realtime, which is exactly what this measurement must not
    // do; -t bounds the looped sample to CONTENT_S of content.
    const args = ffmpegArgs({ input: { kind: 'file', path: sample }, transcode: { encoder: 'copy' }, hls: { time: 2, listSize: 6 }, thumb }, out)
      .filter((a) => a !== '-re')
    let stderr = ''
    const p = spawn('ffmpeg', ['-benchmark', '-t', String(CONTENT_S), ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    p.stderr.on('data', (d) => { stderr += d.toString() })
    // Poll as a fallback: the process exits before a final read can be taken, and
    // ffmpeg's own -benchmark line is getrusage-based, so it carries utime/stime on the
    // production Linux host but only maxrss on Windows.
    let polled = 0
    const poll = setInterval(() => { const v = cpuSeconds(p.pid); if (v != null) polled = v }, 150)
    await new Promise((r) => p.on('exit', r))
    clearInterval(poll)
    try { fs.rmSync(out, { recursive: true, force: true }) } catch {}
    const m = /bench:\s*utime=([\d.]+)s\s*stime=([\d.]+)s/.exec(stderr)
    return m ? { cpu: Number(m[1]) + Number(m[2]), exact: true } : { cpu: polled, exact: false }
  }
  const deltas = []
  let exact = true
  for (let i = 0; i < ROUNDS; i++) {
    const base = await measure(null)
    const thumbed = await measure({ intervalSeconds: INTERVAL_S, width: 320, quality: 7 })
    exact = exact && base.exact && thumbed.exact
    deltas.push(thumbed.cpu - base.cpu)
    log(`   round ${i + 1}: copy ${base.cpu.toFixed(2)} CPU-s → copy+thumbnail ${thumbed.cpu.toFixed(2)} CPU-s ` +
        `per ${CONTENT_S} s of content (delta ${(thumbed.cpu - base.cpu).toFixed(2)})`)
  }
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length
  if (!(meanDelta > 0)) {
    log('   → delta lost in noise on this host — informational only, never a gate. Reference measurement is in hls.js thumbDecodeArgs.')
  } else {
    const perChannelPct = meanDelta / CONTENT_S * 100
    log(`   → +${perChannelPct.toFixed(2)} % of one core per copy channel${exact ? '' : ' (sampled, not getrusage-exact)'}.`)
    log(`     At 89 channels on 4 vCPU that is ~${(89 * perChannelPct / 4).toFixed(0)} % of the whole box, on top of the ~82 % it`)
    log('     already runs at — which is why copy channels are opt-in. Raising the interval does not rescue them:')
    log('     -skip_frame nokey still decodes every keyframe, so the cost is keyframe-rate, not refresh-rate.')
  }

  log('\nRESULT: PASS ✅  (thumbnail lands in the feed drive → refreshes → superseded blobs FREED, held blocks flat → opt-out honoured → replicates P2P → a video-less source still runs)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
