# @aliran/broadcaster

Ingests streams and seeds them to the P2P swarm as **encrypted** feeds. Channels are
runtime start/stoppable — via the env config (single channel, back-compatible) or the
authed HTTP **control API** (multi-channel).

## Run

```bash
cp .env.example .env      # set PANEL_PUBKEY, INPUT, STREAM_ID
npm install               # requires ffmpeg on PATH
node src/index.js
```

To manage channels over HTTP instead (add/configure/start/stop at runtime):

```bash
node src/control-cli.js add-admin op    # prompts for a password (min 8 chars)
CONTROL_ENABLED=1 node src/index.js     # control API at http://127.0.0.1:3310
```

With the control API enabled, the env-configured channel starts only if `STREAM_ID`
is explicitly set; it keeps the legacy `DATA_DIR`-root store, so existing feed
identities (and pre-seeded `feed.key` files) are preserved. See `docs/reference.md`
for the endpoints.

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
- [x] Auto-register stream + metadata with the panel over an authenticated RPC
      (set `PANEL_PUBKEY` + `PUBLISHER_KEY` from `admin-cli init`) — verified `test:register`
- [x] Multi-channel: runtime start/stop via `ChannelManager` + authed control API
      (`CONTROL_ENABLED=1`) — verified `npm run test:broadcaster-api`; web UI next
- [ ] Flip `isLive`/`status` on stop; optional peer allowlist check before replicating

See [`../docs/content-management.md`](../docs/content-management.md).
