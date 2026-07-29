# GPU transcode pack

Setting up a host that transcodes on hardware, and proving it works before you put
channels on it.

Read [docs/kb/gpu-transcoding.md](../../docs/kb/gpu-transcoding.md) first if you have
not: it has the measured costs, the memory finding, and the traps. This file is the
install recipe.

## Scope, honestly

| Path | State |
|---|---|
| **NVIDIA NVENC / NVDEC** | Verified on real hardware (2× RTX 4090, driver 580.159.03, ffmpeg 6.1.1) — encode, decode, HEVC, and the full chain to a playing viewer |
| **Docker via nvidia-container-toolkit** | Compose override provided; the toolkit path itself is **not** verified on hardware here |
| **VAAPI (Intel/AMD)** | Argument path exists and is unit-tested. **Never exercised on real hardware.** Treat as unproven |
| **QSV (Intel)** | Same. On the test host it is *listed* by ffmpeg and correctly probes as unavailable — which is the behaviour to expect when the hardware is absent |

The broadcaster refuses to start a channel whose encoder does not deep-verify, so an
unproven path fails as a clean error rather than a crash loop. That is not the same as
it being tested.

## 1. Driver

The host needs a working NVIDIA driver before anything else. Check first — many
GPU-host providers ship one:

```bash
nvidia-smi
```

If that prints your cards, skip to step 2. Otherwise install the driver your
distribution packages, which is far less painful than the `.run` installer:

```bash
# Ubuntu / Debian
sudo apt-get update
ubuntu-drivers devices          # shows the recommended driver for your cards
sudo apt-get install -y nvidia-driver-580   # or whatever it recommends
sudo reboot
```

After the reboot `nvidia-smi` must print your cards. Nothing below works until it does.

!!! warning "A container can never have a newer driver than its host"
    `nvidia-container-toolkit` exposes the host driver to containers. It does not
    install one.

## 2. ffmpeg with NVENC

Most distribution ffmpeg builds already carry NVENC, because the encoder loads the
driver at runtime rather than linking it at build time:

```bash
sudo apt-get install -y ffmpeg
ffmpeg -hide_banner -encoders | grep -E 'nvenc|libx26'
ffmpeg -hide_banner -decoders | grep cuvid
```

You want `h264_nvenc`, `hevc_nvenc` and the `*_cuvid` decoders. Being listed is not
proof — step 4 is what actually proves it.

## 3. Install the broadcaster

Pick one. Both need the memory setting.

**Bare metal (systemd).** Follow the normal bare-metal install, then use this pack's
unit instead of the default one:

```bash
sudo cp deploy/gpu/aliran-broadcaster-gpu.service /etc/systemd/system/aliran-broadcaster.service
sudo systemctl daemon-reload
sudo systemctl enable --now aliran-broadcaster
```

It differs from `deploy/systemd/aliran-broadcaster.service` in three ways, each
commented in the file: the raised memory ceiling, device access
(`PrivateDevices=false` plus the `render`/`video` groups — the default hardening hides
`/dev/nvidia*` entirely), and a writable CUDA kernel cache.

**Docker.** Install `nvidia-container-toolkit` on the host, then bring the broadcaster
up with the override merged over the base compose file:

```bash
# host, once
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# then
docker compose -f docker-compose.yml -f deploy/gpu/docker-compose.gpu.yml up -d broadcaster
```

!!! danger "Set the memory ceiling or every transcoding channel recycles"
    `FFMPEG_MAX_RSS_MB` defaults to 150. That is correct for `copy` channels and far
    too low for re-encoding, which holds 233 MB (GPU decode) to 439 MB (CPU decode).
    Against the default the watchdog kills and respawns each transcoding channel about
    every 30 seconds, forever, and it looks like a healthy watchdog: `restarts` and
    `memRecycles` climb together. Both install paths in this pack set
    `FFMPEG_MAX_RSS_TRANSCODE_MB=900`; keep it if you edit them.

## 4. Verify before you trust it

```bash
deploy/gpu/verify-gpu.sh
```

Six checks, each of which really encodes or decodes rather than grepping a feature
list: the tools, encoders that actually encode, the full decode→scale→encode chain on
the card, that forced keyframes are honoured (so HLS segments at all), HEVC tagging,
and the memory ceiling. Exit 0 means the host can run the GPU path.

With a broadcaster already running you can also query its own probe:

```bash
CONTROL_USER=admin CONTROL_PASS=… deploy/gpu/verify-gpu.sh --api
```

That reports `encoders[*].verified` and `hwDecode.cuda.verified` — the probe the
broadcaster consults at every channel start, so it is the authoritative answer.

## 5. Configure a channel

In the broadcaster control UI, Edit a channel:

- **Encoder** — `h264_nvenc`, or `hevc_nvenc` for roughly half the bitrate at the same
  quality. Unavailable encoders are shown disabled with the probe's own error as the
  tooltip.
- **GPU decode (NVDEC)** — leave on `auto`. It resolves against the host probe at each
  start and falls back to the CPU by itself if a particular source turns out to be
  undecodable on the card. This is where the large saving is: encode-only leaves most
  of the work on the CPU.
- **GPU device** — pin a card when the host shares its GPUs with anything else. It
  pins decode and encode together.

Then check the channel row: a **GPU** badge means this run really is decoding on the
card. **CPU (fell back)** means the source refused the GPU and the watchdog moved it —
the channel is fine, it just costs more.

## 6. Plan capacity

Not by CPU. On GeForce cards NVENC allows **8 concurrent encode sessions per GPU**, so
two cards carry roughly 16 transcoding channels while 32 vCPU sit mostly idle. Cost per
channel, measured on live sources: about **0.05 cores** for the full GPU path against
**0.83** for `libx264`.

`libx265` exists as a software HEVC fallback for a host with no NVIDIA, but it cost
**26.0 CPU-s against `hevc_nvenc`'s 3.1** for the same output — a few channels, not a
fleet.

## Files

| File | What it is |
|---|---|
| `aliran-broadcaster-gpu.service` | Bare-metal systemd unit for a hardware-encode host |
| `docker-compose.gpu.yml` | Compose override adding NVIDIA device reservations |
| `verify-gpu.sh` | Pre-flight verification; exit 0 = this host can transcode on the GPU |
