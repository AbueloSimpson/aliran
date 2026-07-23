# Repeater appliance (keyless regional super-peer)

The repeater is Aliran's answer to the question every P2P-OTT operator eventually
asks: *what absorbs viewer fan-out when the swarm is young, or when a region's
viewers can't reach each other?* It is the [Netflix
Open Connect](https://openconnect.netflix.com/) idea rebuilt for a peer-to-peer
swarm — a standalone appliance (`repeater/`) that an operator, or a **partner ISP,
on-net**, runs on a high-bandwidth box. It mirrors chosen channels' live windows
and serves them to any viewer that asks, with one decisive difference from a CDN
edge: **the box holds no keys and cannot watch what it serves.**

## What it does

- Joins the swarm topic of each selected channel and **live-mirrors the tail** of
  the channel's two hypercores (feed metadata + media blobs) — a *blind block
  mirror*: it never parses a playlist and never decrypts a byte.
- **Serves automatically**: viewers discover the repeater through the DHT exactly
  like any other peer, and hypercore's request hotswapping prefers the fastest
  holder — so an on-net repeater wins its region **with zero client changes**.
- **Moves fan-out off the origin**: each mirrored channel costs the origin
  broadcaster roughly *one* outbound stream (to the repeater) regardless of how
  many viewers the repeater absorbs. Pair it with the broadcaster's
  `SWARM_MAX_PEERS` cap to *push* viewers onto repeaters deliberately.
- **Follows operations unattended**: channels are selected by streamId against the
  panel's public catalog; when a broadcaster rotates a channel's feedKey (source
  change, RAM-buffer restart), the repeater re-targets through the same catalog
  watch viewers use, and purges the old feed's blocks from disk.

## The security story (why an ISP can host this)

The repeater is **ciphertext-only by construction**, not by policy:

- Its configuration is the panel's **public** key plus channel names. No account,
  no login, no grants, no secrets of any kind on the box.
- It never opens a Hyperdrive — opening one requires the stream's encryption key.
  It mirrors the drive's two cores **raw, at the corestore level**, by public key:
  the `feedKey` from the catalog, and the `blobsKey` the panel publishes beside it
  (the blobs core is a *named* core whose key rides inside the encrypted drive
  header; the panel — which holds every stream's encryption key from broadcaster
  registration — extracts and publishes it precisely so that mirrors can stay
  keyless).
- Everything it stores and serves is encrypted blocks. Watching still requires a
  per-user sealed key from a panel grant — exactly as without a repeater.
  Compromising the box leaks ciphertext and traffic patterns, nothing more.
- Its `package.json` deliberately depends on **no** drive or crypto library, and
  `npm run test:repeater` proves the property end-to-end: it scans a live
  repeater's store for the encryption key and for known plaintext and requires
  zero hits while viewers demonstrably play through it.

This is a strictly better trust profile than a CDN edge cache (which holds
plaintext), and better than the "granted viewer account on a big box" stopgap
(which holds decryption keys).

## Deployment model

```
  origin broadcaster ──(1 stream/channel)──► repeater (ISP A) ──► viewers on ISP A
          │                                  repeater (ISP B) ──► viewers on ISP B
          └──(direct, for stragglers)──────────────────────────► everyone else
```

- **Operator-hosted**: a cheap high-bandwidth VPS per region absorbs the fan-out a
  1-vCPU origin box cannot. The origin's per-channel `SWARM_MAX_PEERS` can then be
  capped low.
- **ISP-hosted (the pitch)**: an ISP that hosts a repeater keeps its subscribers'
  streaming traffic **on-net** (their hypercore requests hotswap to the low-RTT
  box) instead of paying for it at the peering edge — the same economics that made
  Open Connect ubiquitous, minus the trust problem: the appliance cannot see the
  content, so hosting it implies nothing about it.
- Viewers need nothing: discovery is the DHT, preference for the nearby holder is
  hypercore's stock behavior.

## Running one

```sh
# On the repeater box (Docker):
git clone https://github.com/AbueloSimpson/aliran /opt/aliran && cd /opt/aliran
cp repeater/.env.example repeater/.env       # set PANEL_PUBKEY, CHANNELS, …
docker compose -f deploy/docker-compose.repeater.yml up -d --build

# Or bare-metal: repeater/README.md + deploy/systemd/aliran-repeater.service
```

> **Worth running the optional host network tuning on this box in particular.** Absorbing
> fan-out is a repeater's entire job, so of every Aliran component it is the most likely to
> hit the kernel's UDP socket-buffer ceiling — and the clamp is silent, so it presents as
> viewers stalling rather than as a limit. One command, one time:
> `sudo deploy/sysctl/install.sh` (details:
> [network tuning](kb/network-tuning.md), [operator guide](operator-guide.md)).

Configuration (see `repeater/.env.example` for the full comments):

| Env | Default | Meaning |
|-----|---------|---------|
| `PANEL_PUBKEY` | — required | The panel whose public catalog names the channels |
| `CHANNELS` | `all` | `all` · `ch1,ch2` · `category:news[,sports]` |
| `RETENTION_SECONDS` | `300` | Window kept per channel — may be *deeper* than the origin's HLS window (regional blip-recovery buffer) |
| `SWARM_MAX_PEERS` | `256` | Connection budget; a repeater exists to absorb fan-out |
| `DATA_DIR` | `./data` | Ciphertext store — a disposable cache, safe to wipe |
| `STATUS_INTERVAL_SECONDS` | `60` | Per-channel status log cadence (0 = off) |
| `STATUS_PORT` | `0` (off) | Opt-in `GET /healthz` + Prometheus `GET /metrics` server. Off by default — a stock repeater opens **no listening sockets**, and that stays true unless the operator turns this on |
| `STATUS_HOST` | `127.0.0.1` | Status-server bind address (unauthenticated endpoints — widen only on a network you control) |
| `BOOTSTRAP` | public DHT | Custom DHT bootstrap (tests / private DHT) |

## Sizing (pure I/O — no ffmpeg, no transcoding, no crypto)

The repeater does no media work at all; it moves verified blocks. Budget it like a
file server:

- **Bandwidth is the product.** Ingress ≈ one stream bitrate per mirrored channel.
  Egress ≈ the viewers it absorbs: a 1 Gbit/s port sustains ~300 concurrent
  3 Mbit/s viewers; 10 Gbit/s ≈ ~3 000. CPU stays low (no encode/decode) — a
  couple of cores handle the swarm and hashing comfortably.
- **RAM**: tens of MB per mirrored channel plus connection state; 2–4 GB covers a
  large lineup with hundreds of peers.
- **Storage**: `bitrate × RETENTION_SECONDS` per channel (3 Mbit/s × 300 s
  ≈ 110 MB) — the store is a bounded rolling window (expired blocks are cleared
  continuously; rotations purge the old feed entirely) and is disposable.
- **No inbound firewall ports** are required (P2P is outbound UDP with
  hole-punching); `network_mode: host` avoids double-NAT.

Field-measured on a real co-tenanted box (3 mirrored channels, live viewer):
store plateaued flat at ~161 MB total, load average 0.13 on 16 cores, and a stock
viewer pulled 46 % of its stream off the repeater unprompted — the full capture is
the [production worked example](kb/repeater-production-example.md).

## Operational notes

- **Warm-up**: a freshly started (or re-targeted) mirror begins at the live edge —
  it holds a full serving window after ~one origin HLS window has elapsed.
- **Origin outage**: the repeater keeps serving its retained window (deeper
  retention = longer grace), and re-arms automatically when the origin returns.
- **Restart**: mirrored data persists, but the mirror re-joins at the live edge
  and clears leftovers from the previous run — a restart costs one warm-up.
- **Selection by category** re-evaluates live: a channel whose catalog record
  gains/loses the category is picked up/dropped on the next catalog change.
- Panel-**assigned** repeaters (the panel writing a `repeaters/<pubKey>` record
  that a fleet of boxes watches, so admins re-target them from the dashboard) are
  a planned follow-up; today's selection is local config.

## Verification

`npm run test:repeater` runs the end-to-end proof on a local DHT testnet — origin +
panel + repeater + real SDK viewers: (1) with the origin's viewer slots full, a
viewer plays entirely off the repeater (byte counters both sides); (2) the origin
dies mid-play and both a warm and a *cold* viewer keep playing the buffered window;
(3) a feedKey rotation re-targets the mirror unattended and purges the old cores;
(4) retention keeps the store bounded and cleared blocks stay cleared; (5) the
box's store, config and status contain no key material and no plaintext.

Beyond the testnet proof, a production deployment has been captured end to end —
including the socket-buffer clamp warning on an untuned host and the byte-counter
proof of a real viewer served — in the
[production worked example](kb/repeater-production-example.md).
