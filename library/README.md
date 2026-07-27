# @aliran/library

The Aliran **VOD service**: operator-registered video **files** become
encrypted, P2P-seeded **on-demand titles** in the catalog. They use the
unchanged grant machinery and play in the app with full seek.

A title is one catalog record (`type:'vod'` + `durationSec`) plus one encrypted
Hyperdrive holding a finished HLS VOD rendition (`#EXT-X-PLAYLIST-TYPE:VOD` —
**all** segments kept, ending in `#EXT-X-ENDLIST`). Ingest is a **one-shot job**:
ffprobe the input, then `-c copy` remux when the codecs are already
HLS-compatible (h264/hevc + aac/mp3/ac3), or transcode to h264/aac otherwise.
The library then imports the result into a fresh encrypted drive and seeds it
persistently.

## Why this is NOT part of the broadcaster (deliberate architecture)

The broadcaster is a **live pipeline**: watchdogs, rolling windows, feed
rotation, boot-resume pacing. None of that lifecycle applies to a static seed —
a title has no live edge to watch, and it keeps every segment by design. Ingest
is a transcode **burst** (0.5–1 core), and a production live box running near
its CPU ceiling must never absorb that. Operators run the library on whatever
box has the disk and spare cores instead. The failure domains also stay
separate: a library crash never takes channels down.

The storage model matches the repeater's, not the broadcaster's: **one
Corestore + one Hyperswarm** carry every title, because a static seeder needs
one socket pair, not one per title. Each title's encryption key is minted once
and survives re-ingest, so grants sealed to it stay valid — the same contract
as the broadcaster's `feed.key`. A re-ingest mints the next feed **generation**
(a fresh feedKey; viewers follow the catalog) and purges the old one. Deleting
a title purges its cores from disk.

## Running

```sh
cp .env.example .env      # set PANEL_PUBKEY + PUBLISHER_NAME/PUBLISHER_KEY
node src/library-cli.js add-admin op
npm start                 # or: docker compose --profile vod up -d library
```

Enroll the library as its **own** publisher on the panel — never the live
fleet's key — scoped to its title ids:

```sh
# on the panel box
node src/admin-cli.js add-publisher library1 --scopes 'vod-*'   # prints PUBLISHER_KEY once
```

## Managing titles (control API, `CONTROL_ENABLED=1`)

The dashboard lives at `http://127.0.0.1:3320` (loopback-bound — put TLS in
front to expose it). The API takes `Authorization: Bearer <token>` from
`POST /api/login`:

| Route | What |
|---|---|
| `POST /api/titles` | `{id, input, title?, description?, category?, protection?, mode?, hlsTime?}` — create + queue the one-shot ingest. `input` = a file path on this box or any URL ffmpeg reads. |
| `GET /api/titles` / `GET /api/titles/:id` | State + live ingest `{phase, pct}`, peers, panel registration. |
| `POST /api/titles/:id/ingest` | Re-ingest (optionally `{input}`): next feed generation, viewers follow the catalog. |
| `PATCH /api/titles/:id` | `input`/`mode`/`hlsTime` (descriptive metadata is **panel-owned after creation** — edit it there). |
| `DELETE /api/titles/:id` | Stop seeding + purge from disk. The catalog record flips `status:'unavailable'`; remove the record + grants in the panel. |
| `GET /api/titles/:id/logs` | The ingest's ffmpeg log ring. |
| `GET /healthz` | Unauthenticated liveness (`{ok, titles, ready, ingesting, …}`). |
| `GET /metrics` | Unauthenticated Prometheus text (process stats + title-state and panel-link gauges). |

Granting works exactly like channels: run
`node src/admin-cli.js grant <user> <titleId>` on the panel. Viewers see the
title in their catalog with `type:'vod'` and play it with full seek — the SDK
arms none of its live-channel machinery for it.

**Inputs must be finite files.** The library refuses an input with no finite
duration (a live stream, a device) at probe time, because a title keeps all its
segments and an endless input would fill the disk. Live sources belong to the
broadcaster.

**Disk use** equals the sum of title sizes (shown per title in the UI), and only
`delete-title` reclaims it. There is no rolling reclaim and no rotation — that
is the point of VOD.
