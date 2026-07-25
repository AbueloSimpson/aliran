<div align="center">

# Aliran

**Run your own streaming service. Without the bandwidth bill.**

Self-hostable, open-source, peer-to-peer OTT streaming on the
[Holepunch/Pear](https://pears.com) stack. Viewers re-seed each other, so there are
**no central media servers** and delivery cost stays near zero as your audience grows.

[![ci](https://github.com/AbueloSimpson/aliran/actions/workflows/ci.yml/badge.svg)](https://github.com/AbueloSimpson/aliran/actions/workflows/ci.yml)
[![docs](https://github.com/AbueloSimpson/aliran/actions/workflows/docs.yml/badge.svg)](https://abuelosimpson.github.io/aliran/)
[![npm](https://img.shields.io/npm/v/%40aliran%2Fplayer-sdk?label=%40aliran%2Fplayer-sdk)](https://www.npmjs.com/package/@aliran/player-sdk)
[![viewer builds](https://img.shields.io/github/v/release/AbueloSimpson/aliran?label=viewer%20builds)](https://github.com/AbueloSimpson/aliran/releases/latest)
[![license](https://img.shields.io/github/license/AbueloSimpson/aliran)](LICENSE)

[**Documentation**](https://abuelosimpson.github.io/aliran/) ·
[**Quickstart**](https://abuelosimpson.github.io/aliran/quickstart-terminal/) ·
[**Download the apps**](https://github.com/AbueloSimpson/aliran/releases/latest) ·
[**Roadmap**](ROADMAP.md)

<img src="docs/img/desktop/browse.png" width="760" alt="The desktop player: browse overlay over live video — category rail, numbered channel list with program-guide now-lines">

<sub><i>Screenshots show demo channels from the broadcaster's built-in <code>test</code> source (colour bars) — every UI element is real.</i></sub>

</div>

---

> **Status: pre-1.0, actively developed — and running for real.** The full pipeline is
> verified end to end on live infrastructure **over the public DHT**: panel +
> broadcaster deployed on a small VPS via the provided Docker pack, dozens of channels
> ingested 24/7 from real sources, and the Android app (phone + TV) and the Windows
> desktop player logging in and playing live P2P video against it — with the same
> player packaged for macOS, keyless **public viewer builds** on the
> [releases page](https://github.com/AbueloSimpson/aliran/releases/latest), the engine
> published on npm, web admin dashboards for both server components, and a remote
> acceptance harness that proves a deployment from anywhere.

## What do you want to do?

| | | |
|---|---|---|
| 📺 | **Watch a service someone runs** | Grab an app from the [releases page](https://github.com/AbueloSimpson/aliran/releases/latest), then follow the [Android](docs/android-viewer-guide.md) or [desktop](docs/desktop-viewer-guide.md) viewer guide. You'll need a panel key, username and password from your operator. |
| 🖥️ | **Run your own service** | [**Quickstart — terminal**](docs/quickstart-terminal.md): Docker Compose to a live channel in ~15 minutes. Or [**Quickstart — AI assistant**](docs/mcp-quickstart.md) to have an AI client do it through the MCP server. |
| 🛠️ | **Build on it** | The engine is published as [`@aliran/player-sdk`](https://www.npmjs.com/package/@aliran/player-sdk) — see the [Player SDK docs](docs/sdk.md), or [`aliran-kit`](sdk/android/) for native Kotlin. |

There is **no public demo service** — Aliran is infrastructure for operators. You
connect the apps to your own deployment, or to one someone runs for you.

## How it works

```
 ORIGIN (OBS/RTSP/HLS)      Hyperswarm DHT (find peers by public key)
        │                ┌───────────────┬───────────────────────────┐
        ▼                │               │                           │
  broadcaster ──encrypted feed──►  viewer app ◄──re-seed──► viewer app
        │                                ▲       (Android / Windows / macOS)
        └── registers stream ──►  panel  │  login + catalog + entitlement
                                  (accounts, catalog, OPRF)
```

Cooperating peer-to-peer components — all serverless in transport, finding each other
over the Hyperswarm DHT by public key:

| Component | Runs on | Role |
|-----------|---------|------|
| **[`panel/`](panel/)** | Linux / desktop | Origin of truth: signed account DB + stream catalog, OPRF login (brute-force resistant), entitlement tokens |
| **[`broadcaster/`](broadcaster/)** | Linux (headless) | Ingests the original stream (OBS/RTSP/HLS/file) → encrypted P2P feed, seeds the swarm |
| **[`repeater/`](repeater/)** | Linux (headless) | Optional **keyless** regional super-peer (Open-Connect model): mirrors + serves encrypted feeds, absorbs viewer fan-out, cannot watch what it serves |
| **[`library/`](library/)** | Linux (headless) | Optional **VOD service**: one-shot ingest of video files → encrypted, P2P-seeded on-demand titles with full seek, granted like channels |
| **[`reseller/`](reseller/)** | Linux (headless) | Optional **reseller panel**: role hierarchy + credit ledger fronting the panel admin API |
| **[`client/`](client/)** | Android (phone + TV) | The app/APK: logs in, browses an OTT UI, plays the stream, **and re-seeds to other viewers** |
| **[`desktop/`](desktop/)** | Windows & macOS | The desktop player (Electron): the same OTT interface and P2P engine on a PC |
| **[`sdk/`](sdk/)** | anywhere Node runs | The published engine — [`@aliran/player-sdk`](https://www.npmjs.com/package/@aliran/player-sdk): build your own client on the exact engine the apps run |
| **[`sdk/android/`](sdk/android/)** | any Android app (no React Native) | **`aliran-kit`** — native Kotlin SDK, one APK from **Android 5.0** |
| **[`mcp/`](mcp/)** | operator workstation | Optional **MCP server**: install, configure and operate a deployment through an AI client |

### Why this design

- **No infrastructure cost at scale** — clients distribute to each other.
- **Runs behind a firewall** — the panel needs no public IP or open ports (DHT
  hole-punching); optional relay-only mode hides its origin IP.
- **Self-hostable & brandable** — every operator generates their own keys; nothing is
  hardcoded to a single deployment.
- **Security by secrets, not obscurity** — public code, per-deployment keys. See the
  [security model](docs/security-model.md).

## Quickstart

The supported deployment is **Docker Compose** — it pins the two things that actually
break streaming deployments (the ffmpeg build and the Node version) and pre-solves host
networking, volumes and auto-restart.

```bash
git clone https://github.com/AbueloSimpson/aliran && cd aliran
cp panel/.env.example panel/.env
cp broadcaster/.env.example broadcaster/.env
docker compose build

# Generate the panel's identity — prints your panel PUBLIC key (for viewers)
# and the PUBLISHER key (for broadcaster/.env). Back both up.
docker compose run --rm panel node src/admin-cli.js init

docker compose up -d
```

Full walkthrough including accounts, your first channel and connecting a viewer:
**[Quickstart — terminal](docs/quickstart-terminal.md)**. Contributors running the
stack locally from npm workspaces want the [developer tour](docs/getting-started.md)
instead.

## Features

**Streaming & delivery**

- Live P2P streaming (HLS-over-Hyperdrive), viewers re-seed each other
- Resilient ingest: crash/stall watchdog, backup sources, and an **offline slate** — a
  channel whose source dies loops a "SOURCE OFFLINE" card and auto-recovers
- Push (RTMP/SRT/MPEG-TS) and pull (RTSP/HLS/RTMP/SRT/UDP/file) ingest, per-channel
  transcode including GPU encoders
- **Redirect channels** that play an operator CDN/HLS URL directly, no P2P feed behind
- Optional keyless **repeater** super-peers to absorb fan-out
- **VOD**: encrypted, P2P-seeded on-demand titles with full seek

**Apps & viewing**

- Phone **and** Android TV from one codebase, plus Windows & macOS desktop players
- OTT-style GUI: splash auto-auth, menu hub, fullscreen live TV with overlay browsing,
  favorites/search, D-pad navigation on TV
- **Program guide**: on-demand EPG fetched from operator URLs — schedules never bloat
  the P2P catalog
- In-player subtitle/CC and audio-track selection, plus "smooth zapping" prefetch
- **Mobile-honest networking**: on cellular/metered connections the app stops re-seeding
  and throttles prefetch — viewers never burn upload data on a data plan

**Operating it**

- Web admin dashboards for panel (users, streams, grants, art, curation) and
  broadcaster (channels, ingest, transcode, ffmpeg logs)
- Username/password login against a **panel-signed** P2P database, with OPRF
  brute-force resistance, device limits and long-TTL sessions
- **Channel packages** (bouquets) granted as one unit, plus an optional reseller panel
- **Privacy-preserving analytics**: aggregate counts only — per-viewer tracking is
  architecturally impossible, and a test enforces it
- **AI-operable**: an [MCP server](docs/mcp.md) exposing the whole deployment as tools
- **White-label**: brand overlays and per-operator custom builds for Android and desktop

**Deliberate limits**

- **No DRM, by design.** Content protection is transport encryption + per-user sealed
  keys + key rotation — honest access control, not studio-grade DRM. The
  [security model](docs/security-model.md) spells out exactly what that does and does
  not defend against.

## Documentation

Full docs at **<https://abuelosimpson.github.io/aliran/>**.

[Quickstart](docs/quickstart-terminal.md) ·
[Concepts](docs/concepts.md) ·
[Architecture](docs/architecture.md) ·
[Security model](docs/security-model.md) ·
[Operator guide](docs/operator-guide.md) ·
[Configuration](docs/configuration.md) ·
[Player SDK](docs/sdk.md) ·
[Operator build walkthrough](docs/operator-build-walkthrough.md) ·
[Knowledge base](docs/kb/index.md) ·
[FAQ](docs/faq.md)

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup, test lanes and conventions, and [SECURITY.md](SECURITY.md) for
reporting vulnerabilities privately.

## Support the project

Aliran is free and open source. If it's useful to you and you'd like to help fund its
development:

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/abuelosimpson)

Every contribution goes toward the work on the [Roadmap](ROADMAP.md).

## ⚠️ Content-rights disclaimer

Aliran is neutral infrastructure and ships no content. **Operators are solely
responsible** for holding the rights to any content they stream and for complying with
content-licensing and regional/legal requirements in the territories they serve. See
[docs/legal-compliance.md](docs/legal-compliance.md).

## License

[MIT](LICENSE) — free for any use: edit it, redistribute it, or use it commercially.
