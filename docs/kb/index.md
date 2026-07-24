# Knowledge base

Field-tested **symptom → cause → fix** entries, distilled from building and operating
Aliran. Each page is grep-friendly: search for the error text you're seeing.

| Page | Covers |
|---|---|
| [Playback & client runtime](playback.md) | Blank posters, `OPLOG_CORRUPT`, login stalls, black player, worklet crashes |
| [P2P feed buffer & tuning](feed-buffer.md) | `disk` vs `ram` feeds, slow/cold time-to-play, DHT discovery, HLS window sizing (not WebRTC) |
| [Viewer bandwidth & battery](viewer-bandwidth.md) | Measured costs (idle/watching/smooth-zapping), the adaptive prefetch gate, upload policy, metered networks |
| [Network tuning (socket buffers)](network-tuning.md) | Stalling under load with no errors, `RcvbufErrors`/`SndbufErrors`, the `net.core.*mem_max` clamp, conntrack, fd limits |
| [Repeater in production (worked example)](repeater-production-example.md) | A real contained edge deploy, measured: the buffer clamp before/after, a stock viewer pulling 46 % off the repeater, retention plateau, footprint, teardown |
| [Operating the panel & broadcaster](operator.md) | Env vars, grants breaking, `ELOCKED`, wedged processes, login-flood freeze, latency expectations |
| [Backup, restore & key rotation](backup-and-rotation.md) | What to back up (and what's disposable), cold-backup + restore runbooks, the restore-freshness fork hazard, warm standby & never-two-writers failover, the full credential rotation matrix |
| [Offline slate media](offline-slate.md) | The looped "source offline" files: fleet codec/resolution spread, `-stream_loop` timestamp behaviour, why `+genpts` isn't needed, tone choice |
| [Publishing the dashboards](public-dashboards.md) | DNS + Caddy + TLS, the basic-auth/Bearer `Authorization` collision (login popup that never goes away), firewall rules that silently break P2P |
| [Android & React Native builds](android-build.md) | Toolchain traps, emulator crashes/rot, dependency pinning, stale JS bundles |
| [Bare worklet & bundling](bare-worklet.md) | bare-pack flags, shims, native addons, worklet debugging, hyper-stack API traps |

If your issue isn't here, check the [FAQ](../faq.md) or open a
[GitHub issue](https://github.com/AbueloSimpson/aliran/issues) — fixed issues that
taught us something get added to these pages.
