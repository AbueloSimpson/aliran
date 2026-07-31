# @aliran/broadcaster

Ingests streams and seeds them to the P2P swarm as **encrypted** feeds. You can
start and stop channels at runtime — through the env config (single channel,
back-compatible) or the authed HTTP **control API** (multi-channel).

## Run

```bash
cp .env.example .env      # set PANEL_PUBKEY, INPUT, STREAM_ID
npm install               # requires ffmpeg on PATH
node src/index.js
```

To manage channels over HTTP instead (add, configure, start, and stop them at
runtime):

```bash
node src/control-cli.js add-admin op    # prompts for a password (min 8 chars)
CONTROL_ENABLED=1 node src/index.js     # control API at http://127.0.0.1:3310
```

Open that address in a browser to load the **control UI** (`control-ui/`, plain
HTML/JS, no build step). Sign in to add or edit channels — pick the ingest kind
(push kinds the host ffmpeg can't do are hidden) and set per-channel transcode
(unusable encoders are disabled, with the probe error as a tooltip). From there
you can start and stop channels, copy a push channel's **push URL** off its card,
read the ffmpeg **log ring** (a live dialog; the last lines also show inline on an
unhealthy card), and watch live status with honest state badges (ON AIR / WAITING
FOR PUBLISHER / RETRYING). Set `PUBLIC_HOST` so push URLs show your real hostname.
Channel art is a panel admin operation — upload it in the panel dashboard, not here.

With the control API enabled, the env-configured channel starts only if
`STREAM_ID` is explicitly set. It keeps the legacy `DATA_DIR`-root store, so
existing feed identities (and pre-seeded `feed.key` files) are preserved. See
`docs/reference.md` for the endpoints.

## Inputs

Channels take a typed `input` (strings auto-upgrade; the control API accepts
objects):

- `{"kind":"rtmp","port":1935,"streamKey":"…"}` — an RTMP listener; push from
  **OBS** to `rtmp://<host>:<port>/live/<streamKey>`. The key is auto-generated
  when omitted. It is obscurity, not authentication, so firewall the port, or
  prefer SRT instead.
- `{"kind":"srt","port":5000,"passphrase":"…","latencyMs":200}` — an SRT
  listener. The passphrase IS enforced by the SRT handshake, so this is the
  recommended authenticated push.
- `{"kind":"udp","port":5000,"timeoutMs":10000}` — raw MPEG-TS over UDP.
- `{"kind":"pull","url":"rtsp://… | https://…/live.m3u8 | rtmp://… | srt://… | udp://…"}`
  — live pulls run unpaced (no `-re`); plain-http VOD files are paced to realtime.
- `{"kind":"file","path":"/media/loop.mp4"}` (looped) · `{"kind":"test"}` (bars + tone).
- Env shorthand: `INPUT=rtmp` starts an RTMP listener on `RTMP_PORT` (the push URL
  with the generated stream key prints at startup). `INPUT=<url>` pulls from that
  URL. `INPUT=<path>` reads that file.

Push ports are unique per channel. The broadcaster auto-allocates them from
`INGEST_PORT_BASE`–`INGEST_PORT_MAX` (default 5000–5999) when you omit one —
remember to open them on the firewall for your encoder. A per-channel
`transcode` object selects the encoder (`libx264`, `copy` passthrough, or GPU:
`h264_nvenc`/`h264_qsv`/`h264_vaapi`/`h264_amf`), resolution, fps, bitrate, and
preset. The broadcaster deep-verifies GPU encoders with a real test encode at
startup, and it refuses a channel that needs an unusable one, with the probe's
error — there is no silent fallback. With `copy`, set the encoder's keyframe
interval to `HLS_TIME` seconds so segments cut cleanly.

## The feed is a rolling buffer (disk vs RAM)

Live segments are **not archived**. The playlist (`index.m3u8`) is the source of
truth, and the broadcaster deletes anything that rotates out of the window from
the drive and reclaims its blob storage — a channel that streams for weeks
occupies O(window) space, not O(history). Set the window with `HLS_TIME` /
`HLS_LIST_SIZE`. We recommend **12 segments of ~2 s** (≈24 s). The code default
is 8 (≈16 s) — treat it as the floor. Short segments cut time-to-first-frame.
A deeper window gives peers more media to re-seed, and it keeps the window
wider than the ~10 s the viewer players sit behind the live edge.

There are two buffer modes (`FEED_BUFFER` env or per-channel `buffer` field):

- **`disk`** (default) — one persistent on-disk core. The `feedKey` and its DHT
  discovery topic are **stable across restarts**, so a returning viewer rejoins a
  *warm* topic and resumes its on-disk replica instead of cold-discovering a
  brand-new core. This is markedly faster to time-to-play and healthier for P2P.
  The rolling reclaim keeps storage window-bounded (tens of MB), not byte-flat.
- **`ram`** — the feed lives in memory as a **session core**. Every `start()`
  mints a fresh feed keypair and registers the new `feedKey` with the panel, and
  segment data never touches disk. (Reusing one keypair over an emptied RAM store
  would fork the core and break existing replicas, so a restart is a new session
  by design — this is why every restart costs viewers a fresh DHT discovery.)
  Viewers follow along without re-login: the SDK resolves the CURRENT `feedKey`
  from the replicated catalog at play time. Choose this mode only when the host
  disk must stay byte-flat.

In both modes the **encryption key persists** (`feed.key` in the channel's store
dir). User grants seal it, so restarts never invalidate access.

See [`../docs/kb/feed-buffer.md`](../docs/kb/feed-buffer.md) for the P2P tuning
rationale — why disk wins for time-to-play, and how to size the segment window.

## Per-channel swarm budget (`SWARM_MAX_PEERS`)

Every channel owns its **own Hyperswarm**, so connection budgets apply per
channel — hyperswarm's default is 64 peers per channel. `SWARM_MAX_PEERS` makes
the budget an explicit operator knob: the broadcaster drops connections beyond it
at accept time (a refused viewer's player self-heals onto other peers). Raise it
on a big origin box; lower it to push fan-out onto repeater/seed nodes. If you set
it low, leave headroom for non-viewer peers — repeaters and the panel's blobsKey
probe take a slot like any viewer.

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
- [x] Auto-register stream + metadata with the panel over an authenticated RPC
      (set `PANEL_PUBKEY` + `PUBLISHER_KEY`; multi-broadcaster sites add
      `PUBLISHER_NAME` from the panel's `add-publisher` for a per-site key limited
      to admin-assigned channel scopes + `origin` attribution) — verified `test:register`
- [x] Multi-channel: runtime start/stop via `ChannelManager` + authed control API
      (`CONTROL_ENABLED=1`) — verified `npm run test:broadcaster-api`
- [x] Web control UI (`control-ui/`) served by the control server — login, channel
      add/edit/start/stop, live status (ffmpeg/peers/registered/playlist)
- [x] Reliability: ffmpeg **watchdog** (auto-restart with backoff / stalled-edge restart,
      **memory-cap recycle** of a bloating pull via `FFMPEG_MAX_RSS_MB` — some live-HLS
      upstreams accumulate demuxer state no input flag bounds),
      channels **auto-resume** after a broadcaster restart (persisted desired state),
      **`isLive:false` on stop** via one shared panel link (boot catch-up heals stale-live),
      and a per-channel ffmpeg **log ring** — verified `npm run test:broadcaster-api`
- [x] Ingest/transcode/logs surfaced in the control API + UI: `GET /api/capabilities`,
      `GET /api/channels/:id/logs`, status `state` + `ingest.pushUrl`, kind/transcode
      forms + logs dialog + state badges — verified `npm run test:broadcaster-api` + live browser
- [x] Panel link survives a panel restart under a new swarm identity: stranded
      registrations force fresh topic lookups (5 s → 60 s backoff) and status reports
      `no panel connection for Ns` instead of a silent `registered:false` — verified
      `npm run test:panel-link` + `test:broadcaster-api` (Test P)
- [ ] Optional peer allowlist check before replicating

See [`../docs/content-management.md`](../docs/content-management.md).
