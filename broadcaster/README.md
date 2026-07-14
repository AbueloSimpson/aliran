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

Opening that address in a browser loads the **control UI** (`control-ui/`, plain
HTML/JS, no build step): sign in to add/edit channels, start/stop them, and watch
live status (ffmpeg health, peers, panel registration, playlist). Channel art is a
panel admin operation — upload it in the panel dashboard, not here.

With the control API enabled, the env-configured channel starts only if `STREAM_ID`
is explicitly set; it keeps the legacy `DATA_DIR`-root store, so existing feed
identities (and pre-seeded `feed.key` files) are preserved. See `docs/reference.md`
for the endpoints.

## Inputs

Channels take a typed `input` (strings auto-upgrade; the control API accepts objects):

- `{"kind":"rtmp","port":1935,"streamKey":"…"}` — RTMP listener; push from **OBS** to
  `rtmp://<host>:<port>/live/<streamKey>`. The key is auto-generated when omitted and
  is obscurity, not authentication — firewall the port, or prefer SRT.
- `{"kind":"srt","port":5000,"passphrase":"…","latencyMs":200}` — SRT listener; the
  passphrase IS enforced by the SRT handshake (the recommended authenticated push).
- `{"kind":"udp","port":5000,"timeoutMs":10000}` — raw MPEG-TS over UDP.
- `{"kind":"pull","url":"rtsp://… | https://…/live.m3u8 | rtmp://… | srt://… | udp://…"}`
  — live pulls run unpaced (no `-re`); plain-http VOD files are paced to realtime.
- `{"kind":"file","path":"/media/loop.mp4"}` (looped) · `{"kind":"test"}` (bars + tone).
- Env shorthand: `INPUT=rtmp` → RTMP listener on `RTMP_PORT` (the push URL with the
  generated stream key is printed at startup); `INPUT=<url>` → pull; `INPUT=<path>` → file.

Push ports are unique per channel and auto-allocated from
`INGEST_PORT_BASE`–`INGEST_PORT_MAX` (default 5000–5999) when omitted — remember to
open them on the firewall for your encoder. A per-channel `transcode` object selects
the encoder (`libx264`, `copy` passthrough, or GPU: `h264_nvenc`/`h264_qsv`/
`h264_vaapi`/`h264_amf`), resolution, fps, bitrate and preset; GPU encoders are
deep-verified by a real test encode at startup and a channel that needs an unusable
one is refused with the probe's error (no silent fallback). With `copy`, set the
encoder's keyframe interval to `HLS_TIME` seconds so segments cut cleanly.

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
      (`CONTROL_ENABLED=1`) — verified `npm run test:broadcaster-api`
- [x] Web control UI (`control-ui/`) served by the control server — login, channel
      add/edit/start/stop, live status (ffmpeg/peers/registered/playlist)
- [ ] Flip `isLive`/`status` on stop; optional peer allowlist check before replicating

See [`../docs/content-management.md`](../docs/content-management.md).
