# Offline slate media

Pre-rendered "source offline" media that a channel loops when its source dies, so viewers
see a clear message instead of nothing while the watchdog backs off.

This page documents the **assets, their measured properties, and how the broadcaster uses
them**. The media is rendered into the image at build time by `tools/render-slates.sh`.

## Why a file, and why several

**A file, not live-generated bars.** The slate is remuxed with `-c copy` (input kind `file`,
transcode `copy`), so a slated channel costs ~0 CPU and channels configured as `copy` — which
have no encoder settings at all — can slate too. Live `drawtext` would force a re-encode, on
the order of 0.5-1 core per slated channel; across a 69-channel fleet that is the whole box.
It would also put a font dependency in the runtime path.

**Several files, not one.** Slate segments are appended to the *same* `index.m3u8` as the
channel's pre-failure segments (`-hls_flags append_list`). A codec or resolution change
mid-playlist, with no `EXT-X-DISCONTINUITY`, is what actually breaks players. So the slate
must match the dead channel's detected profile on **codec first, resolution second**. Frame
rate and H.264 profile deliberately do *not* vary — a decoder reconfigures across those at an
IDR without a visible break, so varying them would multiply the library for no gain.

## Measured fleet distribution

Probed from a live segment of every running channel (`ffprobe` of the newest `seg*.ts` in
each `/tmp/aliran-hls-*/`). Re-measured 2026-07-21 after the fleet grew 68 → 82 running:

| Codec × height | Channels | Slate |
|---|---:|---|
| h264 720 | 49 | `slate-720p-h264-aac.ts` |
| hevc 1080 | 13 | `slate-1080p-hevc-aac.ts` |
| h264 1080 | 11 | `slate-1080p-h264-aac.ts` |
| hevc 720 | 6 | `slate-720p-hevc-aac.ts` |
| h264 480 / 576 | 3 | 720p h264 — aspect-correct, see below |

**The four variants cover 100% of the fleet**, and did so again unchanged after 14 channels
were added — the codec mix is still h264 (63) and hevc (19) only. Re-run the census after a
bulk import: a new codec (mpeg2video, av1) would silently fall back to 720p h264, which is a
*codec* mismatch and the one thing a player cannot absorb. The one-liner is in the git history
of this page, or just check `detectedProfile` across `GET /api/channels`.

Two things worth knowing before matching:

- **HEVC is 15 of 68 channels, not 2.** Six of them are 720p, which is why the library has a
  720p HEVC entry — without it those channels could only slate on a codec *or* a resolution
  mismatch.
- **H.264 `Main` is the fleet plurality (38), not `High` (13).** The slates are `High`
  anyway: it is a strict superset, universally decodable on anything built since ~2008, and
  profile is one of the things a decoder absorbs at an IDR.
- Frame rates in the fleet are mixed (29.97 ×35, 59.94 ×25, 30 ×7, 23.976 ×1) and **8 channels
  are mono**. The slates are all 30 fps stereo; see below for why that is safe.

## How it works in the broadcaster

The slate rides the existing watchdog rather than adding a parallel one. `_pickSlate` runs
once per respawn, straight after `_pickSource`, so a channel works through **every configured
fallback url before it gives up and shows bars**. When slated, `_spawnFfmpeg` overrides the
input with `{kind:'file', path:<slate>}` and **forces `encoder:'copy'`** — `meta` is never
mutated, so `status()` and a `PATCH` still show what the operator configured (the same
contract the backup-url swap already uses).

Three things are load-bearing and easy to get wrong if this is ever refactored:

- **A looped file never exits and never stalls**, so every exit-driven watchdog path is dead
  while slated. The watchdog kills the slate every `SLATE_RETRY_MS` specifically to re-probe
  the real source; without that the channel shows bars forever after the source returns.
- **`failures` is not reset when leaving the slate to probe.** If the source is still dead,
  the single failed attempt re-slates immediately, so viewers get one brief blip per retry
  instead of a fresh `SLATE_AFTER`-long blank window every cycle.
- **Profile detection is skipped while slated.** Once bars are up, ffmpeg's banner describes
  the *slate*; learning from it would pin the channel to the fallback profile forever.

| Env | Default | Meaning |
|---|---|---|
| `SLATE_ENABLED` | `1` | Master switch |
| `SLATE_DIR` | `broadcaster/slate` | Where the rendered `.ts` files live |
| `SLATE_AFTER` | `3` | Consecutive failed respawns **per source** before slating |
| `SLATE_RETRY_MS` | `60000` | How often a slated channel drops out to re-probe the source |

`SLATE_AFTER` is multiplied by the number of configured sources, so each fallback gets its own
~3 attempts: a 1-url channel slates after 3 failures (~7 s of backoff), a 2-url channel
after 6. If the media is missing the channel **stays on the source** and logs it, rather than
crash-looping ffmpeg against a nonexistent file.

Operators see it in `GET /api/channels/:id` as `slate: { slated, file, since, failures }` plus
`detectedProfile`. That flag matters because a slated channel is healthy by every other
measure — ffmpeg alive, live edge advancing, peers connected — which is the whole point of the
feature and exactly why `state: 'up'` alone can no longer be trusted to mean "showing the
source". Entering and leaving also raise `slate-on` / `slate-retry` incidents.

**Push inputs (rtmp/srt/udp) never slate.** They idle legitimately while awaiting a publisher,
so the watchdog marks them `waiting` rather than respawning, and `failures` never climbs. A
listener with no publisher still shows viewers nothing — worth revisiting, but it is a
different trigger (waiting, not failing) and deliberately out of scope here.

## Non-standard resolutions, and SD

Seven channels are neither 720p nor 1080p. Re-probed 2026-07-21 with pixel aspect included:

| Raster | SAR | DAR | Channels |
|---|---|---|---|
| 852x720 | 3:2 | 71:40 (1.775) | `espn-1-arg`, `espn-2-arg`, `fox-sports-2-arg`, `fox-sports-3-arg` (all **mono**) |
| 720x480 | 32:27 | 16:9 | `via-x-cl`, `zona-latina-cl` |
| 1024x576 | 1:1 | 16:9 | `bein-n` |

**The important result: every channel in the fleet displays at 16:9**, including the SD and
odd rasters — they are anamorphic (non-square pixels), not differently-shaped pictures.
720x480 SAR 32:27 is *exactly* 16:9; 852x720 SAR 3:2 is 1.775 against the slate's 1.778, a
0.2% difference. So the square-pixel 16:9 slate is **aspect-correct fleet-wide** — a slated SD
channel is upscaled, never stretched or letterboxed. No SD slate variant is needed.

Verified by decoding a real mixed playlist (two live segments from the channel, then slate
segments appended as failover would produce them):

| Case | Result |
|---|---|
| `via-x-cl` 720x480 stereo → 720p slate | 246 frames, raster `720x480 → 1280x720`, clean |
| `espn-1-arg` 852x720 **mono** → 720p stereo slate | 246 frames, raster `852x720 → 1280x720`, audio `1ch → 2ch`, clean |

The only decoder complaints were `Packet corrupt` originating in the *live* segment — a
pre-existing property of flaky IPTV sources (see `discardCorrupt` in the ingest tuning), not
caused by the slate.

**Match at selection time, not from a static table.** Source resolutions drift: between two
probes hours apart, `bein-n` moved to 1024x576 and a 718x480 channel disappeared entirely.
The consuming feature must read the channel's *currently detected* profile.

## Failover: swap the INPUT, don't just restart ffmpeg

A restarted ffmpeg resets its output clock. Measured on a channel running ~1.7 h:

```
live channel, newest segment, first DTS : 543226451 ticks = 6036 s
freshly restarted ffmpeg (slate)        :    126000 ticks =    1.4 s
=> DTS would jump BACKWARD ~6034 s
```

Whether that matters depends entirely on how the switch is implemented, because the two
restart paths behave differently. Both were measured on a live channel:

| Switch style | feedKey | Consequence |
|---|---|---|
| Restart with a **changed input** | **rotates** (new generation) | New feed + drive + playlist. Catalog updates, clients auto-follow. The backwards DTS lands in a *fresh* playlist, so it is a non-issue. |
| Plain restart, **same input** | **unchanged** | Same feed, same playlist. Segments append after the old ones with a backwards timeline — this is the case that needs `#EXT-X-DISCONTINUITY`. |

**Implement the slate as an input swap.** That path is verified end-to-end on real hardware
(below) and needs no discontinuity handling at all. Note this holds with `FEED_BUFFER=disk`
— rotation on source change is not a ram-mode-only behaviour.

If a future implementation instead keeps the same feed and only re-points ffmpeg, it **must**
add `discont_start` to the HLS flags:

```
-hls_flags delete_segments+append_list+omit_endlist+discont_start
```

ffmpeg 5.1.9 accepts it and writes `#EXT-X-DISCONTINUITY` ahead of the appended segments.

## On-device verification (Samsung S22 Ultra)

Client is `react-native-video` 6.19.2 → ExoPlayer/Media3 → hardware MediaCodec, which is far
less forgiving than an ffmpeg software decode. Staged as a real failover: a temporary channel
looping an 854x480 program clip, then its input swapped to `slate-720p-h264-aac.ts` and
restarted, watched over the live P2P path.

| What | Result |
|---|---|
| 854x480 → 1280x720 raster change | **Handled.** No stall, no permanent black, no decoder error |
| Time from last program frame to slate on screen | **~2-4 s** (feed rotation + catalog re-resolve + rebuffer) |
| Transition appearance | One brief black frame, then bars |
| Slate rendering | Full-width, correct aspect, message legible |
| Loop wrap, 30 s spanning multiple wraps | **No glitch.** Every captured frame is a clean slate frame; no black, blank or partial frames |

This is the confirmation that mattered: hardware decoders are exactly where mid-stream raster
changes misbehave, and ExoPlayer absorbed it. The ~2-4 s gap is feed re-acquisition, not
decode trouble.

## The files

Rendered by `tools/render-slates.sh` (ffmpeg 8.1.2). All four share: mpegts, 30/1 fps,
timebase 1/90000, 24.000 s, 12 keyframes at exactly 2.000 s, AAC-LC 48 kHz stereo 128 kbps,
`color_range=tv`.

| File | Video | Level | Size | Bitrate |
|---|---|---:|---:|---:|
| `slate-720p-h264-aac.ts` | h264 High, 1280x720, yuv420p | 3.1 | 557 KB | 186 kbps |
| `slate-1080p-h264-aac.ts` | h264 High, 1920x1080, yuv420p | 5.0 | 617 KB | 206 kbps |
| `slate-720p-hevc-aac.ts` | hevc Main, 1280x720, yuv420p | 3.1 | 655 KB | 218 kbps |
| `slate-1080p-hevc-aac.ts` | hevc Main, 1920x1080, yuv420p | 4.0 | 745 KB | 248 kbps |

Content is SMPTE HD bars with a generic **"SOURCE OFFLINE / PLEASE STAND BY"** band. The
message is deliberately generic — one file is shared by many channels, so no channel name is
baked in.

### Why 24 seconds

Not arbitrary. The duration has to make the loop point land exactly:

- 30/1 fps (not 30000/1001) → 24 s is exactly **720 video frames**
- AAC frame = 1024 samples @ 48 kHz → 24 s is exactly **1125 audio frames**
- 2 s GOP → exactly **12 GOPs**, keyframe at t=0,2,…,22

Any multiple of 8 s satisfies the video+audio condition; 24 s sits mid-range of the 10-30 s
the feature wants. A duration that split an AAC frame would leave a few ms of audio short at
every wrap.

## Loop behaviour (verified)

Tested with the real production command shape on the broadcaster container's **ffmpeg 5.1.9**
— the version that will actually loop these in production, not the 8.1.2 that rendered them:

```
ffmpeg -re -stream_loop -1 -i slate-720p-h264-aac.ts \
  -c:v copy -c:a aac -ar 48000 -b:a 128k \
  -f hls -hls_time 2 -hls_list_size 6 \
  -hls_flags delete_segments+append_list+omit_endlist \
  -hls_segment_filename <dir>/seg%d.ts <dir>/index.m3u8
```

**`-fflags +genpts` is NOT required.** Over 78 s (3+ wraps), both h264 and HEVC produced
**zero DTS regressions**, ffmpeg emitted no timestamp warnings at all, and adding `+genpts`,
`+genpts+igndts`, `-copyts` or `-avoid_negative_ts disabled` changed nothing. Do not add it
cargo-cult; it buys nothing here.

**No visible glitch at the wrap** — measured, not eyeballed. Consecutive-frame luma
difference across the whole 3-loop stream: at both wrap points it is **exactly 0.0000**
(pixel-identical). The largest differences anywhere in the file are 0.088/255 at ordinary
keyframes, so the wrap is objectively the *most* seamless transition present.

**No audio click.** With the default silent audio there is nothing to click. With the 1 kHz
tone variant the wrap is also clean, and for a satisfying reason: 1000 Hz × 24.000 s = 24000
whole cycles, so the tone is **phase-continuous** across the wrap. Measured max sample-to-
sample delta in a ±5 ms window at the wrap is 26, against a steady-state maximum of 101 — the
wrap is quieter than the signal's own normal variation.

### Known, accepted: one double-length segment per loop

Each wrap produces **one 4.000 s segment** instead of 2.000 s, so `EXT-X-TARGETDURATION`
becomes 4. Cause: `-stream_loop` with `-c copy` drops the first video frame of each new
iteration, and that frame is the opening IDR — so the muxer has to wait for the next one.
This is inherent to `-stream_loop`; none of the flag combinations above fix it, and neither
does putting two IDRs at the head of the file (the wrap drops both).

It is benign — ffmpeg declares TARGETDURATION correctly and players handle it — but it is why
`hls.time` is not perfectly honoured 100% of the time on a slated channel.

**What the `aresample` in the render command is for.** Without it the AAC priming frame lands
21.33 ms *before* the first video frame. `-stream_loop` advances each iteration by
`max(stream_end) - min(stream_start)`, so that priming frame makes the loop period
24.021333 s instead of 24.000 s — and since the segment grid is anchored to the loop, every
wrap shifts the grid another 21 ms **forever** (~38 s of accumulated skew over a 12 h outage).
`-af aresample=async=1:first_pts=1024` aligns the audio start exactly onto the video start,
giving an exact 24.000 s period and a grid that stays locked. The doubled segment becomes
exactly 4.000 s rather than a drifting 4.021333 s.

Verify after any re-render — **both** streams must read identically:

```
ffprobe -v error -show_entries stream=start_time,duration -of csv=p=0 slate-*.ts
# v=0.066667,24.000000   a=0.066667,24.000000
```

### Harmless warning on HEVC slates

```
[hls @ ...] Stream HEVC is not hvc1, you should use tag:v hvc1 to set it.
```

Cosmetic, and **not fixable from the source file**: mpegts does not carry the tag at all
(`codec_tag_string` reads `HEVC` whether or not `-tag:v hvc1` was used on the source). The
hvc1/hev1 distinction is an ISOBMFF concept the HLS muxer warns about generically. It applies
equally to the 15 existing HEVC production channels. It would only become real if Aliran moves
to CMAF/fMP4 segments.

## Tone: an operator judgement call

`SLATE_TONE` selects the audio, default **`none`**:

| Value | Audio | Notes |
|---|---|---|
| `none` (default) | digital silence | Shipped default |
| `beep` | 1 kHz, −20 dBFS, 0.25 s every 4 s | Proves the audio path is alive |
| `cont` | 1 kHz, −24 dBFS, continuous | Traditional test tone |

Silence is the default because an outage can last hours and a continuous tone is genuinely
hostile over that span; the on-screen text already carries the message. The counter-argument
is real though: silence is indistinguishable from *broken* audio, so `beep` is the better
choice if you want a slated channel to be self-evidently alive. Re-render with
`SLATE_TONE=beep` if you prefer it — this is a preference, not a correctness question.

Whichever is chosen, **real AAC frames are always muxed** (never a missing audio PID), so a
player that waits for audio before presenting video does not stall on a slated channel.

## Where the files live

They are binary, so they are **not in git** — the Dockerfile renders them at build time into
`broadcaster/slate` (the default `SLATE_DIR`). The image already ships everything needed:
`drawtext` (libfreetype), `drawbox`, `smptehdbars`, `anullsrc`, `sine`, `libx264`, `libx265`,
and DejaVu fonts. Rendering there means no binary in git, no manual copy step, and the files
are produced by the *same* ffmpeg that will loop them — which removes the dev-box/container
version skew entirely, the one thing that could silently break the `-c copy` remux.

Caveat: the container's older libx265 emits extra IDRs (every 1 s rather than 2 s) for the
HEVC variants. Harmless — a keyframe still exists at every 2 s boundary, so segmentation is
unaffected — but the files are slightly larger than the 8.1.2-rendered ones.

**To serve them off the data volume instead**, render into `$DATA_DIR/slate/` and set
`SLATE_DIR=/data/slate`. Safe from the GC: `core/store-gc.js` only ever walks
`<storeDir>/cores/`, so a sibling `slate/` directory is never swept. Total cost is ~2.6 MB
against a volume that already churns GBs per day.

## Re-rendering

```bash
./tools/render-slates.sh [OUTDIR]        # default ./slate
SLATE_TONE=beep ./tools/render-slates.sh # with the intermittent beep
SLATE_FONT=/path/to/font.ttf ./tools/render-slates.sh
```

The script carries the full rationale for every non-obvious flag in comments; read it before
changing any of the timing numbers.
