# Knowledge base

Field-tested **symptom → cause → fix** entries from building and running Aliran.
Each page is easy to search — look for the error text you see.

| Page | Covers |
|---|---|
| [Playback & client runtime](playback.md) | Blank posters, `OPLOG_CORRUPT`, login stalls, black player, worklet crashes |
| [P2P feed buffer & tuning](feed-buffer.md) | `disk` vs `ram` feeds, slow/cold time-to-play, DHT discovery, HLS window sizing (not WebRTC) |
| [Viewer bandwidth & battery](viewer-bandwidth.md) | Measured costs (idle/watching/smooth-zapping), the adaptive prefetch gate, upload policy, metered networks |
| [Network tuning (socket buffers)](network-tuning.md) | Stalling under load with no errors, `RcvbufErrors`/`SndbufErrors`, the `net.core.*mem_max` clamp, conntrack, fd limits |
| [Repeater in production (worked example)](repeater-production-example.md) | A real contained edge deploy, measured: the buffer clamp before/after, a stock viewer pulling 46 % off the repeater, retention plateau, footprint, teardown |
| [GPU transcoding (NVENC/NVDEC)](gpu-transcoding.md) | Measured cost per channel, the memory cap that recycles every transcoding channel, HEVC output and why playback needs hls.js, silent `-hwaccel cuda` failure, `overlay_cuda` crashes, session limits |
| [Operating the panel & broadcaster](operator.md) | Env vars, grants breaking, `ELOCKED`, wedged processes, login-flood freeze, latency expectations |
| [Backup, restore & key rotation](backup-and-rotation.md) | What to back up (and what's disposable), cold-backup + restore runbooks, the restore-freshness fork hazard, warm standby & never-two-writers failover, the full credential rotation matrix |
| [Backup & recovery walkthroughs](recovery-walkthroughs.md) | Numbered procedures for both directions: make the escrow file, set up hourly recovery archives, use config snapshots — then undo a bad change, rebuild a lost panel box (archive or escrow-only), roll back to an archive, seed a second site from a template |
| [Compacting the panel bee](panel-bee-compaction.md) | Reclaiming a bee that write-amplification blew up: why `clear()` frees nothing and in-place `truncate()` loses everything, the fork+shadow-rebuild procedure, the fork counter inside the signature, and the other stores that keep a full copy |
| [Offline slate media](offline-slate.md) | The looped "source offline" files: fleet codec/resolution spread, `-stream_loop` timestamp behaviour, why `+genpts` isn't needed, tone choice |
| [Publishing the dashboards](public-dashboards.md) | DNS + Caddy + TLS, the basic-auth/Bearer `Authorization` collision (login popup that never goes away), firewall rules that silently break P2P |
| [Android & React Native builds](android-build.md) | Toolchain traps, emulator crashes/rot, dependency pinning, stale JS bundles |
| [Bare worklet & bundling](bare-worklet.md) | bare-pack flags, shims, native addons, worklet debugging, hyper-stack API traps |

If your issue isn't here, check the [FAQ](../faq.md), or open a
[GitHub issue](https://github.com/AbueloSimpson/aliran/issues). We add fixed
issues that taught us something to these pages.
