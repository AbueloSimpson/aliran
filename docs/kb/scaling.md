# Scaling & capacity planning (channel density)

How many channels can one broadcaster run, what hardware you need, and how to keep the
constant per-segment write churn off your disk. If you're going past a handful of channels,
read this first.

> **TL;DR** — At scale the wall is **disk IOPS**, not space. Turn on the **scale profile**
> (`HLS_WORK_DIR` on tmpfs **+** `FEED_BUFFER=ram`) so segments and the feed live in RAM and
> nothing hammers the disk. Then RAM and CPU set the ceiling. Rough rule for **copy**
> (passthrough) channels: **~40 MB RAM/channel** and **negligible CPU** — so a 4 GB box does
> ~60 channels, a 1 GB box ~14. **Transcoding** channels are CPU-bound instead (~0.5–1 core
> each). Measure your own box with `node tools/scale-bench.mjs`.

## Why this is different from a normal HLS server

nginx/Nimble/Flussonic are HTTP HLS origins: they write the rolling window to tmpfs and serve
`.ts` files over HTTP, so storage = the window and every viewer pulls from the origin/CDN.

Aliran has **no central media server** — viewers re-seed each other. The segments aren't served
over HTTP; they're written into an **encrypted Hypercore** and replicated over the DHT. That
append-only, verifiable log is exactly what makes P2P re-sharing possible — and it's why the
storage/IO story is its own thing (see [feed buffer & tuning](feed-buffer.md)). What matters for
scale is that **every segment is written more than once** (ffmpeg → scratch dir → the Hypercore,
plus the tree/oplog/metadata), so at high channel counts you become **IOPS-bound long before
you run out of space or bandwidth** — the same reason traditional streaming uses a ramdisk.

## The scale profile

Two independent write paths hit disk by default. Move both to RAM:

| Lever | What it moves to RAM | How |
|---|---|---|
| `HLS_WORK_DIR` on a **tmpfs** | ffmpeg's live-window scratch (`seg*.ts`, `index.m3u8`) | mount a tmpfs, point `HLS_WORK_DIR` at it |
| `FEED_BUFFER=ram` | the **Hypercore** feed store (data + tree + metadata) | env var (or per-channel `buffer:"ram"`) |

Together = **zero segment IOPS on disk.** In `docker-compose.yml` (already stubbed, commented):

```yaml
  broadcaster:
    environment:
      HLS_WORK_DIR: /hlstmp
      FEED_BUFFER: ram
    tmpfs:
      - /hlstmp:size=512m      # ~ (HLS_LIST_SIZE + 2) x segment_size x channels
```

Bare-metal: `HLS_WORK_DIR=/dev/shm/aliran` (Linux `/dev/shm` is already tmpfs) + `FEED_BUFFER=ram`.

**The trade** (see [feed-buffer.md](feed-buffer.md) for the full explanation): `ram` mints a
**fresh feedKey on every restart**, so returning viewers pay a cold DHT rejoin (~40–55 s) — but
the player **auto-follows** the new key via the catalog, no re-login. On a big multi-channel box
that reset is also your natural way to clear the slow append-only metadata creep. If you instead
want stable feedKeys (warm ~10 s reconnect) and can spare the disk, keep `FEED_BUFFER=disk` and
just move `HLS_WORK_DIR` to tmpfs — that alone removes the *heavier* of the two write paths.

## The four walls (per-channel cost)

Measured: dev box (i5-8259U, 8 core) and the live 1 vCPU / 1 GB VPS, **copy passthrough**
channels (the common case: pull a source, re-mux, no encode).

| Resource | Per channel (copy) | Notes |
|---|---|---|
| **RAM** | **~40 MB** | ~3 MB feed engine (Corestore+Hyperdrive+Hyperswarm) + ~38 MB marginal ffmpeg (VmRSS ~70 MB but libs are shared). Base runtime ~70–90 MB. |
| **CPU** | **~1.5% of one core** | Just the mux + mirror. Copy does no encoding. |
| **Disk IOPS** | ~2.5–5 sync ops/s | 1 segment / 2 s × several fsync'd writes (core append, oplog, metadata B-tree). **This is the wall** — put it on tmpfs. |
| **Disk space** | ~6 MB (bounded) + ~100 MB/day creep | `disk` mode only. Window data is bounded (the reclaim fix); the append-only merkle tree creeps. `ram` mode = 0 disk. |
| **DHT** | 1 swarm + topic | Socket fan-out grows with peers × channels; the practical network wall on very large deployments. |

**Transcoding changes the CPU line entirely:** x264 SD ≈ 0.5–1 core/channel, 1080p more. If
you transcode, **CPU is your wall**, not RAM — a 4-core box does ~4–6 x264 SD channels, not 60.
Use `copy` wherever the source codec is already deliverable.

## Capacity formula

```
max_channels ≈ min(
    (RAM_MB − 90) / 40,          # RAM, copy   (÷ more for transcode's bigger ffmpeg)
    cores / cpu_per_channel,     # copy ≈ 0.015 core/ch ; x264 SD ≈ 0.5–1 core/ch
    disk_iops / 4,               # ONLY if not on tmpfs — the scale profile removes this term
    dht_socket_budget            # very large deployments; shard across nodes
)
```

### Starter table — copy channels, scale profile on (RAM-bound)

| Box | RAM | Cores | ~Max copy channels | First wall |
|---|---|---|---|---|
| Raspberry Pi 4 | 2 GB | 4 | ~30 | RAM |
| Raspberry Pi 4/5 | 4 GB | 4 | ~60 | RAM |
| Raspberry Pi 5 | 8 GB | 4 | ~125 | RAM |
| Small VPS (the Aliran box) | 1 GB | 1 | ~14 | RAM |
| VPS | 2 GB | 2 | ~30 | RAM |
| VPS | 4 GB | 4 | ~60 | RAM |
| Server | 8 GB | 8 | ~125 | RAM |

For **transcoding** deployments, recompute the CPU term and it dominates: the 8-core server that
does ~125 copy channels does only **~8–12 x264 SD** channels.

!!! success "Measured on the reference box (1 vCPU / 1 GB / 2 GB swap)"
    A real load test with live pull sources (copy passthrough, `disk` mode): **15 channels ran
    cleanly** (all live, ~377 MB broadcaster, load ~1.9); **~18–20 tipped into swap-thrash** (load
    climbed past 8, the box went sluggish — no OOM kill, but unusably slow). So the table's ~14 is
    a *safe* number — the real ceiling was a bit higher because ffmpeg's shared libraries make the
    **marginal** RAM cost ~25–30 MB/channel, not the ~40 MB a single process suggests. On a
    RAM-bound box the wall is **RAM → swap-thrash**, not CPU or IOPS (disk writes stayed ~modest).

!!! warning "Short-term ceiling ≠ sustained ceiling (7-hour duration test)"
    Running those 15 channels for ~7 hours told a two-part story. **Disk passed:** segment data
    stayed bounded (oscillated ~55–225 MB tracking the live channel count, no runaway; the metadata
    tree crept only ~110 MB/day for the whole set — far below a naive per-channel extrapolation),
    confirming the reclaim fix holds at scale over time. **But compute drifted:** the broadcaster's
    RSS crept over the hours until the box began swapping (swap 0.6 → 1.1 GB), and it slid into a
    **thrash + ffmpeg-respawn spiral** — the live ffmpeg count churned 9–15 (the watchdog kills a
    CPU-starved stalled edge, then respawns it) and load ran a sustained 7–19 on the one core. No
    OOM, but 15 channels is **not sustainable 24/7 on this box**. Treat the "runs cleanly" figure as
    a *short-term* ceiling and size a long-running deployment **a few channels below it** (≈8–10
    here): multi-hour RSS growth, not the fresh-start footprint, sets the real limit.

> **Counter-intuitive but important:** on a **RAM-constrained** box, `FEED_BUFFER=ram` is the
> *wrong* lever — it moves the whole feed store *into* RAM, so you hit the RAM wall **sooner**.
> The scale profile (ram + tmpfs) is for boxes that are **IOPS-bound with RAM to spare** (spinning
> disk / SD card, many channels). On a small RAM-bound VPS, keep `FEED_BUFFER=disk`.

> **Past ~one box's worth, scale horizontally.** 200 channels isn't a single-node story in any
> storage mode — it's also 200 ffmpeg processes and 200 DHT topics. Shard channels across N
> broadcaster nodes (each registers with the same panel); the panel catalog already aggregates
> them. RAM+tmpfs is the right *per-node* engine; sharding is how you reach the hundreds.

## Measure your own hardware

Absolute numbers are hardware-specific. Run the bench **on the target box** (it uses a local DHT
testnet, never the public network, and production-representative copy channels):

```bash
node tools/scale-bench.mjs --channels 8 --seconds 60                 # disk mode
node tools/scale-bench.mjs --channels 8 --buffer ram --workdir /dev/shm/ab   # scale profile
```

It reports per-channel node RAM, ffmpeg RAM (Linux), CPU, the **allocated** on-disk footprint
(sparse-aware — meaningful on Linux/ext4), and a RAM-bound ceiling for several budgets. Run it at
a couple of `--channels` values and read the *marginal* cost between them.

## Recovering an overloaded broadcaster

If you push past the wall and the box goes into **swap-thrash** (load ≫ cores, everything
crawls, SSH sluggish), don't try to fix it channel-by-channel through the API — under thrash
each `stop` waits on the panel flush and takes seconds. Shed load decisively:

```bash
# 1. force the broadcaster down (SIGKILL after 5 s) — instant RAM/CPU relief
docker stop -t 5 aliran-broadcaster-1
# 2. keep only the channels you want; drop the rest from the registry
V=/var/lib/docker/volumes/aliran_broadcaster-data/_data
python3 -c "import json;d=json.load(open('$V/channels.json'));\
json.dump({i:v for i,v in d.items() if i in ('ch1','ch2')},open('$V/channels.json','w'),indent=2)"
# 3. bring it back — only the kept channels auto-resume
docker start aliran-broadcaster-1
```

!!! danger "Auto-resume can turn one OOM into a boot loop"
    Every started channel persists `desiredRunning:true`. If the box hard-OOMs, Docker restarts
    the broadcaster and it **auto-resumes them all at once** — and simultaneous starts spike
    higher than steady state, so a box that was stable *running* N channels can fail to *boot*
    them. Stay a couple of channels below the measured ceiling, and shed the registry (step 2)
    before restarting a box that's already at the edge. A `MAX_CHANNELS` start guardrail on the
    broadcaster is a sensible future addition.

## Raspberry Pi broadcaster (experimental)

A Pi is a good low-power edge broadcaster for **copy** channels. The scale profile isn't optional
here — it's what saves the SD card:

- **64-bit OS is mandatory.** The crypto (`sodium-native`) and disk-reclaim (`fs-native-extensions`)
  native modules ship **`linux-arm64` prebuilds only** — no 32-bit `linux-arm`. On 32-bit Raspberry
  Pi OS the broadcaster won't even start. Use **arm64 Raspberry Pi OS / Ubuntu** (Pi 4 or 5).
- **tmpfs is essential.** An SD card has terrible random IOPS *and* wears out from constant small
  writes — exactly what an HLS window is. Always run the scale profile (`HLS_WORK_DIR` on tmpfs +
  `FEED_BUFFER=ram`) so the churn never touches the card. (This also sidesteps the fact that
  disk-mode hole-punch reclaim depends on the card's filesystem.)
- **Copy, not transcode.** The Pi's CPU won't transcode many streams; its hardware encoder
  (`h264_v4l2m2m`) is an advanced, per-source setup. Pull already-H.264 sources and `copy`.
- **Build:** the image is multi-arch (base `node:24-bookworm-slim`). Build for the Pi with:
  ```bash
  docker buildx build --platform linux/arm64 -f broadcaster/Dockerfile -t aliran-broadcaster:arm64 .
  ```
  or just `docker compose build` natively on the Pi. Debian bookworm's ffmpeg (arm64) has the
  demuxers/protocols for HTTP/RTSP/SRT pulls out of the box.

Sizing follows the table above (Pi 4 2 GB ≈ 30 copy channels), with tmpfs sized into the RAM
budget. Treat it as experimental until load-tested with `scale-bench.mjs` on the specific board.
