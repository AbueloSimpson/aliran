# Aliran Documentation

Aliran is a self-hostable, peer-to-peer OTT streaming platform on the Holepunch/Pear
stack. This folder is the source for the docs site (MkDocs Material; diagrams use
Mermaid), published at <https://abuelosimpson.github.io/aliran/>.

## Contents

- [Getting started](getting-started.md) — quick tour for operators, developers, users
- [Concepts](concepts.md) — P2P / Pear / Bare primer, glossary
- [Architecture](architecture.md) — the five components, data flows, **sequence diagrams**
- [Security model](security-model.md) — threat model, auth, brute-force, DRM, geo, **and honest limits**
- [Operator guide](operator-guide.md) — install, generate keys, run panel + broadcaster, HA
- [Repeater appliance](repeater.md) — optional keyless regional super-peer (Open-Connect model)
- [VOD library](https://github.com/AbueloSimpson/aliran/blob/main/library/README.md) — optional standalone service for on-demand titles (`type:'vod'`; API in [Reference](reference.md), ops in the [operator guide](operator-guide.md))
- [Configuration](configuration.md) — full config reference for every component
- [Content management](content-management.md) — catalog, metadata, assets, DRM, geo, VOD
- [Client build](client-build.md) — build the Android (phone + TV) app
- [User management](user-management.md) — accounts, passwords, devices, sessions
- [Reference](reference.md) — admin-cli, panel RPC, schemas
- [Development log](devlog.md) — the detailed, chronological build history (the concise summary is [CHANGELOG.md](https://github.com/AbueloSimpson/aliran/blob/main/CHANGELOG.md))
- [Knowledge base](kb/index.md) — field-tested symptom→cause→fix entries
- [FAQ & troubleshooting](faq.md) — common questions and fixes
- [Legal & compliance](legal-compliance.md) — content rights, DRM licensing, regional rules
- [Roadmap](https://github.com/AbueloSimpson/aliran/blob/main/ROADMAP.md) — milestones from alpha to 1.0 and beyond
- [ADRs](adr/0001-record-architecture-decisions.md) — architecture decision records

## Building the site

```bash
pip install mkdocs-material mkdocs-mermaid2-plugin
mkdocs serve          # local preview at http://127.0.0.1:8000
```

Publishing is automatic: every push to `main` that touches `docs/` or `mkdocs.yml`
rebuilds and deploys the site to GitHub Pages via
[`.github/workflows/docs.yml`](https://github.com/AbueloSimpson/aliran/blob/main/.github/workflows/docs.yml).

## Status

In active development, pre-1.0 — and running on real infrastructure. The full stack is
implemented and verified end to end: panel + broadcaster (+ optional repeater)
deployed via the provided Docker/systemd pack, web admin dashboards for both, and the
Android app (phone + TV) playing live P2P streams over the public DHT. Pages reflect
what is built; forward-looking items (DRM, VOD, geo-locking, panel HA) are marked as
such and tracked in the
[Roadmap](https://github.com/AbueloSimpson/aliran/blob/main/ROADMAP.md).
