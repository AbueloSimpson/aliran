# @aliran/broadcaster

Ingests an existing stream and seeds it to the P2P swarm as an **encrypted** feed.

## Run

```bash
cp .env.example .env      # set PANEL_PUBKEY, INPUT, STREAM_ID
npm install               # requires ffmpeg on PATH
node src/index.js
```

## Inputs

- `INPUT=rtmp` → run an RTMP listener; push from **OBS** to `rtmp://<host>:1935/live/stream`
- `INPUT=rtsp://…` / `http://…/playlist.m3u8` / `/path/file.mp4` → pull/loop a source

## Test it (no Android needed)

```bash
node src/index.js                                   # prints feedKey + encKey
node ../tools/viewer.js <feedKey> <encKey>          # play at http://127.0.0.1:<port>/index.m3u8
# or the automated proof:
node ../tools/e2e-stream-test.mjs                   # PASS = end-to-end P2P verified
```

## Status / TODO

- [x] Encrypted Hyperdrive feed + Hyperswarm seeding
- [x] Persist/reuse the feed encryption key across restarts
- [x] ffmpeg ingest → live HLS (test pattern / RTSP / HLS / file), `out/ → drive` mirror
- [x] Verified end-to-end (ffmpeg → P2P → localhost → ffprobe) via `tools/e2e-stream-test.mjs`
- [ ] `PROTECTION=drm` path via a multi-DRM packager (CENC/CMAF, CPIX keys) — v1.x
- [ ] Register stream + metadata with the panel; flip `isLive` on start/stop — v0.2
- [ ] Optional peer allowlist check before replicating — v0.2

See [`../docs/content-management.md`](../docs/content-management.md).
