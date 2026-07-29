# GPU transcoding (NVENC / NVDEC)

This is what a hardware-encode host actually gives you, what it costs, and
the traps that only show on real hardware.

Every number here was measured on one host: 2× NVIDIA RTX 4090, 32 vCPU,
125 GiB, Ubuntu 24.04, driver 580.159.03, ffmpeg 6.1.1. Where a figure came
from live production feeds instead of a synthetic pattern, the page says so,
because the difference is large.

## What the GPU is for

A channel with `encoder: copy` does not decode or encode. It remuxes, it
costs almost nothing, and a GPU adds nothing to it. **The GPU only helps a
channel that re-encodes.**

Two separate jobs can move to the card:

- **Encode** — `h264_nvenc` or `hevc_nvenc` instead of `libx264`.
- **Decode and scale** — `hwDecode`, which adds `-hwaccel cuda` and
  `scale_cuda`, so frames never enter system memory.

Doing only the first leaves most of the work on the CPU. The measurements
below show the difference.

## Cost per channel

Synthetic 1080p30 to 720p at 3000 kbps, CPU-seconds per 30 s of content:

| Path | CPU-s | Cores per realtime stream |
|---|---|---|
| Decode, scale and encode on the GPU | 1.6 | **0.053** |
| `h264_nvenc` with CPU decode and scale | 12.9 | 0.43 |
| `libx264` veryfast | 25.0 | 0.83 |

The same comparison against **live production sources** (about 20 s each; an
H.264 High 720p feed and an HEVC Main 1080p feed):

| Path | CPU-s |
|---|---|
| h264 1080p to 720p, GPU decode | 1.4 |
| hevc 1080p to 720p, GPU decode | 2.0 – 2.7 |
| h264 720p to 720p, CPU decode | 5.1 |
| hevc 1080p to 720p, CPU decode | 16.5 |
| `libx264` 1080p to 720p | 17.8 |

On real content the full GPU path is about **12.7× cheaper than libx264**
and about **6× cheaper than NVENC with CPU decode**. Both margins are wider
than the synthetic test showed, which is the expected direction: real 1080p
video costs far more to decode on a CPU than a test pattern does.

`libx265` is not a like-for-like alternative to `hevc_nvenc`. At 480p from
the same source it cost **26.0 CPU-s against 3.1** — about 8× — so software
HEVC suits a few channels, not a fleet.

## What limits channels per host

Not CPU. On NVENC the limit is the **concurrent encode-session count per
GPU**, which on GeForce cards is 8. Two cards therefore carry roughly 16
transcoding channels, long before 32 vCPU become the constraint.

!!! note "This figure is documented, not measured here"
    The 8-session cap comes from NVIDIA's own limits. It was not measured on
    the test host, because finding it means deliberately exhausting sessions
    on a machine that was also running live channels.

Use `transcode.gpu` to pin a channel to one card. It sets both
`-hwaccel_device` and `-gpu`, and it was verified to map to the same device
indices `nvidia-smi` reports. Pinning matters most on a shared host: it is
how you keep your channels off a card another service is using.

## Memory: the cap that must change

A transcoding channel holds real frame buffers. Measured steady state on a
live 1080p source:

| Path | RSS |
|---|---|
| GPU decode | 233 MB |
| CPU decode | **439 MB** |

**The CPU path is the heavier of the two.** Decoded frames sit in system
memory instead of staying on the card.

`FFMPEG_MAX_RSS_MB` defaults to 150. That is correct for `copy`, which
remuxes in 13-30 MB, and far too low for anything that re-encodes. Against
150 MB the watchdog recycles a transcoding channel about every 30 seconds,
permanently, and it looks like a healthy watchdog doing its job: `restarts`
and `memRecycles` climb together while the channel flaps between `up` and
`backoff`.

The broadcaster therefore applies the cap **per channel**: `copy` keeps the
150 MB ceiling, and anything that re-encodes uses
`FFMPEG_MAX_RSS_TRANSCODE_MB` (default 900, about twice the worst measured
steady state, so a real leak is still caught).

!!! warning "Raise this on any host you switch to transcoding"
    If you set `FFMPEG_MAX_RSS_MB` by hand on an existing box, make sure it
    is above the transcode floor, or your first GPU channel will recycle
    every 30 seconds.

## HEVC output

`hevc_nvenc` and `libx265` roughly halve bitrate at the same quality, which
on a P2P feed is bandwidth every viewer stops having to re-seed. The trade
is decoder reach, so HEVC is an operator choice per channel and never a
default.

Three things to know before you use it:

- **The tag is required.** HEVC in HLS needs `-tag:v hvc1`, which the
  broadcaster adds automatically. Without it a range of players refuse the
  stream. ffmpeg's own HLS muxer warns about this.
- **Playback depends on the client transmuxing.** Media Source Extensions
  reject `video/mp2t; codecs="hvc1…"` outright. The desktop shell plays HEVC
  only because hls.js converts the MPEG-TS segments to fMP4 in JavaScript
  first. A player that hands `.ts` straight to a `<video>` element will fail
  on HEVC while working normally on H.264.
- **Changing an existing channel to HEVC is a restart, not a live switch.** A
  codec change is the one thing a player cannot absorb mid-playlist.

Verified on the test host: a live H.264 feed transcoded to `hevc_nvenc` 720p
replicated over the DHT to a fresh viewer, and hls.js 1.6 with Chromium
decoded it with no errors at 1280×720. Chromium decodes HEVC in MP4;
Electron bundles its own Chromium build and needs its own check.

## Traps

**`-hwaccel cuda` fails silently.** Given a codec CUVID cannot decode — a
10-bit H.264 stream, for instance — ffmpeg substitutes the *software*
decoder without saying so. The failure then appears at the filter graph as
`Impossible to convert between the formats`, not as a decoder error. This is
a property of the **source**, not the host, so no capability probe can
predict it. The broadcaster watches for that signature and respawns the
channel on the CPU decoder, which costs one brief restart.

**`overlay_cuda` crashes this ffmpeg.** It looks like the correct way to
composite a logo without leaving the card, and on ffmpeg 6.1.1 with driver
580.159.03 it segfaults in every configuration tested. Logos therefore
composite on the CPU. It also accepts only nv12, which carries no alpha, so
even a working version would render a transparent PNG as a solid box.

**Subtitles and alpha blending are CPU-only filters.** On the GPU path they
need an explicit round trip through system memory. The broadcaster builds
that automatically. It costs about twice the GPU baseline and still less
than half of decoding on the CPU.

**A looping `file` source breaks the GPU round trip at the wrap.** `file`
inputs loop, and when the file wraps ffmpeg reinitialises the filter graph,
which the CUDA upload does not survive. Measured: three channels held exact
2.000 s segments for 28 s, then failed together at the 30 s loop boundary.
It self-heals onto the CPU decoder. Live sources — pulls and push listeners
— never wrap, so they never meet this.

**NVENC ignores forced keyframes unless told not to.** `h264_nvenc` and
`hevc_nvenc` need `-forced-idr`, which the broadcaster sets. Without it the
HLS muxer finds no keyframe to cut on, and with the low-latency tune there
is no periodic IDR either: 13 s of input becomes one 12.9 s segment, the
live window never rolls, and a late joiner has nothing to start from.

**H.264 NVENC is 8-bit only.** A 10-bit source reaches it as `yuv420p10le`
and is refused with `No capable devices found`, which reads like a missing
GPU rather than a pixel format. The broadcaster pins 8-bit on the CPU-decode
path. `hevc_nvenc` could emit 10-bit, and is deliberately held at 8-bit too,
because 10-bit narrows the set of viewer devices that can decode it.

## Verifying a host

The broadcaster probes its own ffmpeg once per process and refuses to start
a channel whose encoder is unavailable, so the fastest check is the
capability endpoint:

```bash
curl -s -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:3310/api/capabilities
```

`encoders` reports each encoder as `listed` (compiled in) and `verified`
(actually encoded frames). The distinction matters: a build routinely lists
an encoder whose hardware is absent — the test host lists `h264_qsv` with no
Intel GPU anywhere. `hwDecode.cuda` reports whether the whole
decode-scale-encode chain runs on the card, tested by really running it,
because `-hwaccel cuda` cannot be trusted to fail loudly. `gpus` lists the
NVIDIA devices `nvidia-smi` reports, so the control UI can name cards
instead of asking for an index.

To watch what a running channel is doing, its status carries `hwDecode`:

- `active` — whether this run is decoding on the GPU
- `configured` — what the operator asked for (`auto`, `true`, `false`)
- `fellBack` — true when this source refused the GPU and the watchdog moved
  it to the CPU
- `gpu` — the pinned device, if any

`auto` plus the per-source fallback means neither the channel's settings nor
the host probe answer "is this on the GPU right now" on their own. This
field does.

## Related

- [Scaling and capacity planning](scaling.md) — channel ceilings measured on
  the production box.
- [Source compatibility](source-compatibility.md) — what pull ingest accepts
  and the demuxer tuning difficult sources need.
