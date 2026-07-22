# Aliran

[![ci](https://github.com/AbueloSimpson/aliran/actions/workflows/ci.yml/badge.svg)](https://github.com/AbueloSimpson/aliran/actions/workflows/ci.yml)

**Aliran** (Malay/Indonesian: *flow / stream / current*) — a self-hostable,
open-source, **peer-to-peer OTT streaming platform** built on the
[Holepunch/Pear](https://pears.com) stack. Streams flow peer to peer: viewers
re-seed each other, so there are **no central media servers** and near-zero
bandwidth cost.

> **Status: pre-1.0, actively developed — and running for real.** The full pipeline is
> verified end to end on live infrastructure: panel + broadcaster deployed on a 1 GB
> VPS via the provided Docker pack, channels ingested from real sources, and the
> Android app (phone + TV) logging in and playing live P2P video **over the public
> DHT** — plus web admin dashboards for both server components and a remote
> acceptance harness that proves a deployment from anywhere. See the
> [Roadmap](ROADMAP.md) for what's done vs. planned, [CHANGELOG.md](CHANGELOG.md)
> for the shipped-feature summary, and each package's `README.md` for details.

## What it is

Five cooperating peer-to-peer components (all serverless in transport — they find
each other over the Hyperswarm DHT by public key):

| Component | Runs on | Role |
|-----------|---------|------|
| **[`panel/`](panel/)** | Linux / desktop | Origin of truth: signed account DB + stream catalog, OPRF login (brute-force resistant), entitlement tokens |
| **[`broadcaster/`](broadcaster/)** | Linux (headless) | Ingests the original stream (OBS/RTSP/HLS/file) → encrypted P2P feed, seeds the swarm |
| **[`repeater/`](repeater/)** | Linux (headless) | Optional **keyless** regional super-peer (Open-Connect model): mirrors + serves encrypted feeds, absorbs viewer fan-out, cannot watch what it serves |
| **[`library/`](library/)** | Linux (headless) | Optional **VOD service**: one-shot ingest of video files → encrypted, P2P-seeded on-demand titles with full seek, granted like channels |
| **[`client/`](client/)** | Android (phone + TV) | The app/APK: logs in, browses an OTT UI, plays the stream, **and re-seeds to other viewers** |
| **[`desktop/`](desktop/)** | Windows | The desktop player (Electron): the same OTT interface and P2P engine on a PC — installer + portable exe |

```
 ORIGIN (OBS/RTSP/HLS)      Hyperswarm DHT (find peers by public key)
        │                ┌───────────────┬───────────────────────────┐
        ▼                │               │                           │
  broadcaster ──encrypted feed──►  client (APK) ◄──re-seed──► client (APK)
        │                                ▲
        └── registers stream ──►  panel  │  login + catalog + entitlement
                                  (accounts, catalog, OPRF)
```

## Why P2P / why this design

- **No infrastructure cost at scale** — clients distribute to each other.
- **Runs behind a firewall** — the panel needs no public IP or open ports (DHT hole-punching); optional relay-only mode hides its origin IP.
- **Self-hostable & brandable** — every operator generates their own keys and config; nothing is hardcoded to a single deployment.
- **Security by secrets, not obscurity** — public code, per-deployment keys. See [`docs/security-model.md`](docs/security-model.md).

## Quickstart

```bash
# 1. Panel (origin of truth)
cd panel && cp .env.example .env && npm install
node src/admin-cli.js init            # generate panel + OPRF keys
node src/admin-cli.js create-user alice
node src/index.js                     # start the panel node

# 2. Broadcaster (content origin)
cd ../broadcaster && cp .env.example .env && npm install
node src/index.js                     # ingest -> encrypted Hyperdrive -> swarm

# 3. Client (Android app) — see client/README.md for the native build
```

For a real deployment, run the server stack with **Docker Compose** (the supported
path — pinned ffmpeg/Node, auto-restart, host networking pre-configured) — see the
[operator guide](docs/operator-guide.md).

## Features

- Live P2P streaming (HLS-over-Hyperdrive), viewers re-seed each other
- Phone **and** Android TV from one codebase
- Username/password login validated against a **panel-signed** P2P database
- Brute-force resistance (OPRF + throttling), device limits, long-TTL sessions
- OTT-style GUI: splash auto-auth, menu hub, fullscreen live TV with overlay browsing,
  favorites/search, D-pad navigation on TV — white-label themable
- Web admin dashboards: panel (users, streams, grants, art, curation) and broadcaster
  (channels, push/pull ingest, transcode incl. GPU, ffmpeg logs)
- Resilient ingest: crash/stall watchdog, backup sources, and an **offline slate** — a
  channel whose source dies loops a "SOURCE OFFLINE" card and auto-recovers, never going
  blank
- **Redirect channels**: catalog entries that play an operator's CDN/HLS URL
  directly — no P2P feed behind them
- Self-healing playback: tune watchdog, wedged-connection teardown, live-edge stall
  resync — plus optional keyless **repeater** super-peers to absorb fan-out
- **Optional** modules: commercial multi-DRM (BuyDRM/KeyOS, EZDRM, Axinom…), geo-locking, VOD

## Documentation

Browse online at **<https://abuelosimpson.github.io/aliran/>**, or start at
[`docs/README.md`](docs/README.md). Highlights:
[Getting started](docs/getting-started.md) ·
[Architecture](docs/architecture.md) ·
[Security model](docs/security-model.md) ·
[Operator guide](docs/operator-guide.md) ·
[Configuration](docs/configuration.md) ·
[Knowledge base](docs/kb/index.md) ·
[FAQ](docs/faq.md).

## Roadmap

See [`ROADMAP.md`](ROADMAP.md) for the path from alpha to a production-ready 1.0
(streaming → auth/OTT UI → HA/hardening) and the optional modules (VOD, DRM, geo).

## Support

Aliran is free and open source. If it's useful to you and you'd like to help fund
its development, you can buy me a coffee:

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/abuelosimpson)

Every contribution is appreciated and goes toward building the Android app and the
optional modules on the [Roadmap](ROADMAP.md).

## ⚠️ Content-rights disclaimer

Aliran is neutral infrastructure. **Operators are solely responsible** for holding
the rights to any content they stream and for complying with DRM licensing and
regional/legal requirements in the territories they serve. See
[`docs/legal-compliance.md`](docs/legal-compliance.md).

## License

[MIT](LICENSE) — see the file for details. Free for any use: edit it, redistribute
it, or use it commercially.
