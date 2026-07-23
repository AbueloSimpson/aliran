# VOD library (on-demand titles)

The **library** is Aliran's VOD service: operator-registered video **files** become
encrypted, P2P-seeded **on-demand titles** in the catalog — entitled through the
unchanged grant machinery and playing in the apps with full seek. It is a separate
deployable (`library/`), run beside the panel and broadcaster on a small setup or
on entirely different hardware
([source on GitHub](https://github.com/AbueloSimpson/aliran/tree/main/library)).

A **title** is one catalog record (`type:'vod'` + `durationSec`) plus one encrypted
Hyperdrive holding a **finished** HLS rendition (`#EXT-X-PLAYLIST-TYPE:VOD` —
**all** segments kept, ending in `#EXT-X-ENDLIST`). The record class differs from a
live channel in exactly two fields: `durationSec` (measured at ingest) and **no
`isLive` at all** — liveness is not a property a title has, and clients must not
read liveness into vod records. `status` reads `'available'` while the library
seeds the title and `'unavailable'` after the library deletes it (the record itself
is admin-owned and stays until removed in the panel). Grants, sealing, blobsKey
enrichment, art, curation and categories work identically for both classes — see
the [catalog schema](reference.md#schemas).

## Why this is not part of the broadcaster

The broadcaster is a **live pipeline**: watchdogs, rolling windows, feed rotation,
boot-resume pacing. None of that lifecycle applies to a static seed — a title has
no live edge to watch and keeps every segment by design. Ingest is a transcode
**burst** (0.5–1 core) that a production live box running near its CPU ceiling must
never absorb; operators run the library on whatever box has the disk and spare
cores — it needs only outbound UDP and the panel's public key. And the failure
domains stay separate: a library crash never takes channels down.

## Storage model

The storage model is the [repeater](repeater.md)'s, not the broadcaster's: **one
Corestore + one Hyperswarm** carry every title (a static seeder needs one socket
pair, not one per title). Each title's encryption key is minted **once** and
survives re-ingest, so grants sealed to it stay valid — the same `feed.key`
contract the broadcaster honors. A re-ingest mints the next feed **generation**
(fresh `feedKey`; viewers follow through the catalog) and purges the old one's
cores. Deleting a title purges its cores from disk.

## Ingest: one-shot, finite inputs only

Adding a title queues a **one-shot job**: ffprobe the input → `-c copy` remux when
the codecs are already HLS-compatible (h264/hevc + aac/mp3/ac3 — no transcode CPU
at all), else transcode to h264/aac with keyframes on segment boundaries → import
into a fresh encrypted drive → seed persistently. `input` is a file path on the
library box or any URL ffmpeg reads.

**Inputs must be finite files.** An input with no finite duration (a live stream, a
capture device) is refused at probe time — a title keeps all its segments, so an
endless input would fill the disk. Live sources belong to the broadcaster.
Transcodes run one at a time by default (`INGEST_CONCURRENCY=1`).

## Running it

```sh
# Enroll the library as its OWN publisher on the PANEL (never reuse the live
# fleet's key). Title ids must match the scopes; prints PUBLISHER_KEY once.
node src/admin-cli.js add-publisher library1 --scopes 'vod-*'

# On the library box:
cp .env.example .env      # PANEL_PUBKEY + PUBLISHER_NAME/PUBLISHER_KEY + CONTROL_ENABLED=1
node src/library-cli.js add-admin op
npm start                 # or: docker compose --profile vod up -d library
```

The compose service ships behind the **`vod` profile**, so a plain
`docker compose up -d` never starts it. The full single-box walkthrough (build,
control admin, first title, grant) is in the
[operator guide](operator-guide.md#g-the-vod-library-optional).

## Managing titles

`CONTROL_ENABLED=1` serves a control dashboard + API at `http://127.0.0.1:3320`
(loopback-bound — [put TLS in front](kb/public-dashboards.md) to expose it): add
titles, watch ingest progress (`{phase, pct}`), read the ingest's ffmpeg log ring,
re-ingest, delete. Two ownership rules worth knowing:

- **Descriptive metadata is panel-owned after creation.** A title's
  `title`/`description`/`category` are seeded once when the record is first created
  and then belong to the panel admin (exactly like art, EPG and curation) — edit
  them in the panel, not on the library.
- **Delete is two-sided.** Deleting a title stops seeding and **purges its cores
  and key from the library box** (refused mid-ingest), and the catalog record flips
  `status:'unavailable'` — but the record and its grants are admin-owned; remove
  them in the panel.

The full endpoint table and environment reference live in the
[reference](reference.md#library-control-api-ui-control_enabled1).

## Granting and playback

Granting works exactly like channels — `grant <user> <titleId>` on the panel (CLI,
admin API or dashboard). Viewers see the title in their catalog and play it with
full seek; the SDK arms **none** of its live-channel machinery for a vod record (no
tune watchdog, no zap prefetch — a finished playlist never advances, so the live
machinery would false-fire), and client UIs key their seek/pause transport off
`type === 'vod'`, never off a URL shape. See the
[SDK installation & configuration guide](sdk-guide.md).

## Disk and sizing

Disk on the library box = the **sum of title sizes** (shown per title in the UI),
reclaimed **only by delete** — no rolling reclaim, no rotation; that is the point
of VOD. Ingest at `-c copy` is I/O-bound and quick; a transcode runs ~0.5–1 core
for roughly the title's runtime ÷ encode speed. Serving is the same seeder
economics as the repeater — bandwidth, not CPU. A seeder is send-dominant, so under
real fan-out raise `SWARM_SNDBUF_MB` and the host's `wmem_max`
([network tuning](kb/network-tuning.md)).

The `library/.env` variable rows are in the
[configuration reference](configuration.md#library-libraryenv-vod).
