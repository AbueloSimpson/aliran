<div align="center">

# Aliran

**Run your own streaming service. Without the bandwidth bill.**

Self-hostable, open-source, peer-to-peer OTT streaming on the
[Holepunch](https://pears.com) stack — Android (phone + TV), Windows and macOS
players. Viewers **re-seed** live channels to each other, so delivery scales
through the audience instead of central media servers, and bandwidth cost stays
near zero as it grows.

[![ci](https://github.com/AbueloSimpson/aliran/actions/workflows/ci.yml/badge.svg)](https://github.com/AbueloSimpson/aliran/actions/workflows/ci.yml)
[![docs](https://github.com/AbueloSimpson/aliran/actions/workflows/docs.yml/badge.svg)](https://abuelosimpson.github.io/aliran/)
[![npm](https://img.shields.io/npm/v/%40aliran%2Fplayer-sdk?label=%40aliran%2Fplayer-sdk)](https://www.npmjs.com/package/@aliran/player-sdk)
[![npm](https://img.shields.io/npm/v/%40aliran%2Fmcp?label=%40aliran%2Fmcp)](https://www.npmjs.com/package/@aliran/mcp)
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

> **Status: pre-1.0, actively developed — and running for real.** The full pipeline
> works end to end on live infrastructure **over the public DHT**. The panel and
> broadcaster run on a small VPS through the provided Docker pack. Dozens of channels
> ingest 24/7 from real sources. The Android app (phone and TV) and the Windows
> desktop player log in and play live P2P video against it, and the same player is
> packaged for macOS. Keyless **public viewer builds** are on the
> [releases page](https://github.com/AbueloSimpson/aliran/releases/latest), the engine
> is published on npm, web admin dashboards exist for both server components, and a
> remote acceptance harness proves a deployment from anywhere.

## What do you want to do?

| | | |
|---|---|---|
| 📺 | **Watch a service someone runs** | Install a [public build](#get-the-apps) below, then follow the [Android](docs/android-viewer-guide.md) or [desktop](docs/desktop-viewer-guide.md) viewer guide. You'll need a panel key, username and password from your operator. |
| 🖥️ | **Run your own service** | [**Quickstart — terminal**](docs/quickstart-terminal.md): Docker Compose to a live channel in ~15 minutes. Or [**Quickstart — AI assistant**](docs/mcp-quickstart.md) to have an AI client do it through the MCP server. |
| 🛠️ | **Build on it** | The viewer engine ships as [`@aliran/player-sdk`](https://www.npmjs.com/package/@aliran/player-sdk), plus [`@aliran/react-native`](https://www.npmjs.com/package/@aliran/react-native) and native Kotlin [`aliran-kit`](sdk/android/). Start at the [Player SDK docs](docs/sdk.md), or see [all components](#how-it-works). |

### Get the apps

Keyless **public builds** of every viewer are on the
**[releases page](https://github.com/AbueloSimpson/aliran/releases/latest)**:

| Platform | Build |
|---|---|
| **Windows** | Installer + portable exe |
| **macOS** | Apple silicon + Intel (dmg/zip) |
| **Android** | One build covers phone **and** Android TV. Pick your device's ABI: `arm64-v8a` for most devices, `armeabi-v7a` for older 32-bit TV boxes. APKs install from **Android 7**; live P2P playback needs **Android 10+** |

On first run, each app shows a **Connect screen**. Enter the three things your
operator gives you: the **panel public key**, a **username**, and a **password**.
The app then finds the service over the P2P network — no URLs, no port forwarding.
Install steps, including the unsigned-build warnings each OS shows, are in the
[desktop viewer guide](docs/desktop-viewer-guide.md) (Windows and macOS) and the
[Android viewer guide](docs/android-viewer-guide.md).

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

These are cooperating peer-to-peer components. All of them are serverless in
transport — they find each other over the Hyperswarm DHT by public key.

**Services you run** — the deployment. Only the first two are required:

| Component | Runs on | Role |
|-----------|---------|------|
| **[`panel/`](panel/)** | Linux / desktop | Origin of truth: signed account DB + stream catalog, OPRF login (brute-force resistant), entitlement tokens, admin dashboard |
| **[`broadcaster/`](broadcaster/)** | Linux (headless) | Ingests the original stream (OBS/RTSP/HLS/file) → encrypted P2P feed, seeds the swarm; control dashboard |
| **[`repeater/`](repeater/)** *(optional)* | Linux (headless) | **Keyless** regional super-peer (Open-Connect model): mirrors + serves encrypted feeds, absorbs viewer fan-out, cannot watch what it serves |
| **[`library/`](library/)** *(optional)* | Linux (headless) | **VOD service**: one-shot ingest of video files → encrypted, P2P-seeded on-demand titles with full seek, granted like channels |
| **[`reseller/`](reseller/)** *(optional)* | Linux (headless) | **Reseller panel**: role hierarchy + credit ledger fronting the panel admin API |

**Apps your viewers install:**

| Component | Runs on | Role |
|-----------|---------|------|
| **[`client/`](client/)** | Android (phone + TV) | The app/APK: logs in, browses an OTT UI, plays the stream, **and re-seeds to other viewers**. Runs the SDK in a [Bare](https://github.com/holepunchto/bare) worklet |
| **[`desktop/`](desktop/)** | Windows & macOS | The desktop player (Electron): the same OTT interface and P2P engine on a PC |

**Libraries & tools you build on** — published to npm:

| Package | Source | Role |
|---------|--------|------|
| [`@aliran/core`](https://www.npmjs.com/package/@aliran/core) | [`core/`](core/) | The crypto foundation every component shares: OPRF, Argon2id, key sealing, token signing |
| [`@aliran/player-sdk`](https://www.npmjs.com/package/@aliran/player-sdk) | [`sdk/`](sdk/) | The headless viewer engine — the exact engine the apps run. Build your own client |
| [`@aliran/react-native`](https://www.npmjs.com/package/@aliran/react-native) | [`sdk/react-native/`](sdk/react-native/) | React Native binding: `AliranBackend` + `<AliranVideo>` |
| [`@aliran/mcp`](https://www.npmjs.com/package/@aliran/mcp) | [`mcp/`](mcp/) | **MCP server**: install, configure and operate a deployment through an AI client |
| *(Gradle, from source)* | [`sdk/android/`](sdk/android/) | **`aliran-kit`** — native Kotlin SDK for Android apps without React Native; one APK from **Android 5.0** |

**Running and developing the repo:**

| Directory | What's in it |
|-----------|--------------|
| [`deploy/`](deploy/) | Docker Compose, systemd units, the Caddy TLS recipe, backup/restore scripts, the sysctl tuning drop-in |
| [`tools/`](tools/) | The e2e test suites, a headless viewer, the scale bench, and `acceptance-remote.mjs` — proves a deployment from any machine |
| [`examples/`](examples/) | Minimal integration examples, including a headless player |
| [`docs/`](docs/) | Source for the [documentation site](https://abuelosimpson.github.io/aliran/) |

### Why this design

- **No infrastructure cost at scale** — clients distribute to each other.
- **Runs behind a firewall** — the panel needs no public IP or open ports (DHT
  hole-punching). An optional relay-only mode hides its origin IP.
- **Self-hostable & brandable** — every operator generates their own keys. Nothing
  is hardcoded to a single deployment.
- **Security by secrets, not obscurity** — public code, per-deployment keys. See the
  [security model](docs/security-model.md).

## Quickstart

The supported deployment is **Docker Compose**. It pins the two things that most
often break streaming deployments — the ffmpeg build and the Node version — and it
pre-solves host networking, volumes, and auto-restart.

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

For the full walkthrough — accounts, your first channel, and connecting a viewer —
see the **[Quickstart — terminal](docs/quickstart-terminal.md)**. If you are a
contributor running the stack locally from npm workspaces, use the
[developer tour](docs/getting-started.md) instead.

## Features

**Streaming & delivery**

- Live P2P streaming (HLS-over-Hyperdrive), viewers re-seed each other
- Resilient ingest: crash/stall watchdog, backup sources, and an **offline slate**.
  When a channel's source dies, it loops a "SOURCE OFFLINE" card and recovers
  automatically — it never goes blank
- Push (RTMP/SRT/MPEG-TS) and pull (RTSP/HLS/RTMP/SRT/UDP/file) ingest, per-channel
  transcode including GPU encoders
- **Redirect channels** that play an operator CDN/HLS URL directly, no P2P feed behind
- Self-healing playback: tune watchdog, wedged-connection teardown, live-edge stall
  resync — plus optional keyless **repeater** super-peers to absorb fan-out
- **VOD**: encrypted, P2P-seeded on-demand titles with full seek

**Apps & viewing**

- Phone **and** Android TV from one codebase, plus Windows & macOS desktop players
- OTT-style GUI: splash auto-auth, menu hub, fullscreen live TV with overlay browsing,
  favorites/search, D-pad navigation on TV
- **Program guide**: on-demand EPG fetched from operator URLs — schedules never bloat
  the P2P catalog
- In-player subtitle/CC and audio-track selection, plus "smooth zapping" prefetch
- **Mobile-honest networking**: on a cellular or metered connection, the app stops
  re-seeding and throttles prefetch. Viewers never burn upload data on a data plan

**Operating it**

- Web admin dashboards for panel (users, streams, grants, art, curation) and
  broadcaster (channels, ingest, transcode, ffmpeg logs)
- Username/password login against a **panel-signed** P2P database, with OPRF
  brute-force resistance, device limits and long-TTL sessions
- **Channel packages** (bouquets) granted as one unit, plus an optional reseller panel
- **Privacy-preserving analytics**: aggregate counts only — per-viewer tracking is
  architecturally impossible, and a test enforces it
- **AI-operable** (optional): point an MCP-capable AI client at
  [`@aliran/mcp`](https://www.npmjs.com/package/@aliran/mcp). It can install a fresh
  server, tune it, curate content, run backups and restores, and answer usage
  questions from the shipped docs. It has 100+ tools plus guided runbooks, and
  secrets never leave the operator's machine. See [docs/mcp.md](docs/mcp.md)
- **White-label**: brand overlays (name, colours, logo, wallpaper, TV banner) and
  per-operator custom builds for Android and desktop. The
  [operator build walkthrough](docs/operator-build-walkthrough.md) goes from your
  keys to a branded APK and exe

**Deliberate limits**

- **No DRM, by design.** Content protection comes from transport encryption,
  per-user sealed keys, and key rotation — honest access control, not studio-grade
  DRM. The [security model](docs/security-model.md) spells out exactly what this
  does and does not defend against.

## Documentation

Full docs at **<https://abuelosimpson.github.io/aliran/>**.

[Quickstart](docs/quickstart-terminal.md) ·
[Concepts](docs/concepts.md) ·
[Architecture](docs/architecture.md) ·
[Security model](docs/security-model.md) ·
[Operator guide](docs/operator-guide.md) ·
[Configuration](docs/configuration.md) ·
[Player SDK](docs/sdk.md) ·
[MCP server (AI-operable ops)](docs/mcp.md) ·
[Desktop viewer guide](docs/desktop-viewer-guide.md) ·
[Android viewer guide](docs/android-viewer-guide.md) ·
[Operator build walkthrough](docs/operator-build-walkthrough.md) ·
[Knowledge base](docs/kb/index.md) ·
[FAQ](docs/faq.md)

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup, test lanes, and conventions. See [SECURITY.md](SECURITY.md) to
report vulnerabilities privately.

## Support the project

Aliran is free and open source. If it's useful to you and you'd like to help fund its
development:

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/abuelosimpson)

Every contribution goes toward the work on the [Roadmap](ROADMAP.md).

## ⚠️ Content-rights disclaimer

Aliran is neutral infrastructure and ships no content. **Operators are solely
responsible** for holding the rights to any content they stream. They must comply
with content-licensing and regional and legal requirements in the territories they
serve. See [docs/legal-compliance.md](docs/legal-compliance.md).

## License

[MIT](LICENSE) — free for any use: edit it, redistribute it, or use it commercially.
