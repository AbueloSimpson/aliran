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

## Status / TODO

- [x] Encrypted Hyperdrive feed + Hyperswarm seeding wiring
- [ ] Persist/reuse the feed encryption key across restarts
- [ ] ffmpeg ingest → live HLS, and the `out/ → drive` mirror (rolling window)
- [ ] `PROTECTION=drm` path via a multi-DRM packager (CENC/CMAF, CPIX keys)
- [ ] Register stream + metadata with the panel; flip `isLive` on start/stop
- [ ] Optional peer allowlist check before replicating

See [`../docs/content-management.md`](../docs/content-management.md).
