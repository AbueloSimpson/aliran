# Knowledge base

Field-tested **symptom → cause → fix** entries, distilled from building and operating
Aliran. Each page is grep-friendly: search for the error text you're seeing.

| Page | Covers |
|---|---|
| [Playback & client runtime](playback.md) | Blank posters, `OPLOG_CORRUPT`, login stalls, black player, worklet crashes |
| [P2P feed buffer & tuning](feed-buffer.md) | `disk` vs `ram` feeds, slow/cold time-to-play, DHT discovery, HLS window sizing (not WebRTC) |
| [Viewer bandwidth & battery](viewer-bandwidth.md) | Measured costs (idle/watching/smooth-zapping), the adaptive prefetch gate, upload policy, metered networks |
| [Operating the panel & broadcaster](operator.md) | Env vars, grants breaking, `ELOCKED`, wedged processes, login-flood freeze, latency expectations |
| [Android & React Native builds](android-build.md) | Toolchain traps, emulator crashes/rot, dependency pinning, stale JS bundles |
| [Bare worklet & bundling](bare-worklet.md) | bare-pack flags, shims, native addons, worklet debugging, hyper-stack API traps |

If your issue isn't here, check the [FAQ](../faq.md) or open a
[GitHub issue](https://github.com/AbueloSimpson/aliran/issues) — fixed issues that
taught us something get added to these pages.
