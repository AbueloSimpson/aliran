# Aliran

**Aliran** (Malay/Indonesian: *flow / stream / current*) — a self-hostable,
open-source, **peer-to-peer OTT streaming platform** built on the
[Holepunch/Pear](https://pears.com) stack. Streams flow peer to peer: viewers
re-seed each other, so there are **no central media servers** and near-zero
bandwidth cost.

> **Status: early / in development.** The peer-to-peer core works and is verified on
> desktop — live streaming over P2P (`npm run test:stream`) and brute-force-resistant
> username/password login (`npm run test:login`) both pass end to end. The Android app
> and the OTT UI are not built yet. See the [Roadmap](ROADMAP.md) for exactly what's
> done vs. planned, and each package's `README.md` for details.

## What it is

Three cooperating peer-to-peer components (all serverless in transport — they find
each other over the Hyperswarm DHT by public key):

| Component | Runs on | Role |
|-----------|---------|------|
| **[`panel/`](panel/)** | Linux / desktop | Origin of truth: signed account DB + stream catalog, OPRF login (brute-force resistant), entitlement tokens |
| **[`broadcaster/`](broadcaster/)** | Linux (headless) | Ingests the original stream (OBS/RTSP/HLS/file) → encrypted P2P feed, seeds the swarm |
| **[`client/`](client/)** | Android (phone + TV) | The app/APK: logs in, browses an OTT UI, plays the stream, **and re-seeds to other viewers** |

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

## Quickstart (once implemented)

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

## Features

- Live P2P streaming (HLS-over-Hyperdrive), viewers re-seed each other
- Phone **and** Android TV from one codebase
- Username/password login validated against a **panel-signed** P2P database
- Brute-force resistance (OPRF + throttling), device limits, long-TTL sessions
- OTT-style GUI: hero, rails, LIVE badges, D-pad navigation on TV
- **Optional** modules: commercial multi-DRM (BuyDRM/KeyOS, EZDRM, Axinom…), geo-locking, VOD

## Documentation

Start at [`docs/README.md`](docs/README.md). Highlights:
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
