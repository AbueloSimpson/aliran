# @aliran/repeater

A **keyless regional super-peer** — the Netflix-Open-Connect analog for the Aliran
swarm. A standalone hosted app that an operator (or a partner ISP, on-net) runs on a
high-bandwidth box: it mirrors chosen channels' live windows and serves them to
viewers, so fan-out moves **off the origin broadcaster** — the origin's per-channel
egress drops to roughly one stream per repeater — and, when ISP-hosted, viewer
traffic stays on the local network. Hypercore's request hotswapping prefers fast,
low-RTT holders, so an on-net repeater wins locally with **zero client changes**.

## The trust story (why an ISP can host this)

The box is **ciphertext-only, by construction**:

- no account, no login, no grants — configuration is just the panel's *public* key;
- it never opens a Hyperdrive (opening one requires the stream's encryption key);
  it mirrors the drive's two hypercores **raw**, at the corestore level;
- everything it stores and serves is encrypted blocks; **it cannot watch what it
  serves**, and compromising the box leaks nothing but ciphertext.

Watching still requires a per-user sealed key from a panel grant — exactly as
without a repeater. (Strictly better than a CDN edge cache, which holds plaintext.)

## How it works

1. It replicates the panel's **public catalog** (the same pre-login read every
   viewer does): `catalog/<streamId>` carries each channel's `feedKey` and — via the
   panel's blobsKey enrichment — the `blobsKey` of the drive's (named, not publicly
   derivable) blobs core.
2. Per selected channel it joins the channel's swarm topic (`hash(feedKey)` — the
   same topic origin and viewers use), opens **both cores by key**, and
   live-downloads their tails (`core.download({ start: length, end: -1 })`).
3. A time-based sweep clears blocks older than the retention window — a **blind
   block mirror**: no playlist parsing, no decryption; storage is O(window)/channel.
4. Serving is automatic: corestore replication answers block requests from any
   viewer that connects; feedKey rotations (broadcaster source change / restart)
   re-target the mirror via the catalog watch, unattended.

## Run

```sh
cp .env.example .env      # set PANEL_PUBKEY (+ CHANNELS, RETENTION_SECONDS, …)
npm install
npm start
```

Docker (from the repo root): `docker compose -f deploy/docker-compose.repeater.yml up -d --build`
· bare-metal service: `deploy/systemd/aliran-repeater.service`.

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `PANEL_PUBKEY` | — (required) | The panel whose catalog names the channels |
| `CHANNELS` | `all` | `all`, `ch1,ch2`, or `category:news[,sports]` |
| `RETENTION_SECONDS` | `300` | Live window kept per channel (may exceed the origin's) |
| `SWARM_MAX_PEERS` | `256` | Connection budget — a repeater exists to absorb fan-out |
| `DATA_DIR` | `./data` | Ciphertext block store (disposable cache) |
| `STATUS_INTERVAL_SECONDS` | `60` | Per-channel status log cadence (0 = off) |
| `BOOTSTRAP` | public DHT | Custom DHT bootstrap nodes (tests / private DHT) |

## Sizing (pure I/O — no ffmpeg, no transcoding)

- **Bandwidth is the product**: ingress ≈ one stream bitrate per mirrored channel;
  egress ≈ however many viewers it absorbs. A 1 Gbit/s box serves ~300 concurrent
  SD viewers (3 Mbit/s) with CPU to spare.
- **RAM**: tens of MB per mirrored channel (hypercore session + replication state).
- **Storage**: `bitrate × RETENTION_SECONDS` per channel (3 Mbit/s × 300 s ≈ 110 MB);
  the store is a disposable cache — safe to wipe between runs.
- Pair with the origin's `SWARM_MAX_PEERS` (broadcaster env) to *push* fan-out onto
  repeaters: cap the origin low, size the repeater high.

See `docs/repeater.md` for the full operator page (deployment model, verification,
security discussion). Test suite: `npm run test:repeater` from the repo root.
