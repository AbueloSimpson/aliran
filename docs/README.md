# Aliran Documentation

Aliran is a self-hostable, peer-to-peer OTT streaming platform on the Holepunch/Pear
stack. This folder is the source for the docs site (publishable with Docusaurus or
MkDocs Material; diagrams use Mermaid).

## Contents

- [Getting started](getting-started.md) — quick tour for operators, developers, users
- [Concepts](concepts.md) — P2P / Pear / Bare primer, glossary
- [Architecture](architecture.md) — the three components, data flows, **sequence diagrams**
- [Security model](security-model.md) — threat model, auth, brute-force, DRM, geo, **and honest limits**
- [Operator guide](operator-guide.md) — install, generate keys, run panel + broadcaster, HA
- [Configuration](configuration.md) — full config reference for every component
- [Content management](content-management.md) — catalog, metadata, assets, DRM, geo, VOD
- [Client build](client-build.md) — build the Android (phone + TV) app
- [User management](user-management.md) — accounts, passwords, devices, sessions
- [Reference](reference.md) — admin-cli, panel RPC, schemas
- [FAQ & troubleshooting](faq.md) — common questions and fixes
- [Legal & compliance](legal-compliance.md) — content rights, DRM licensing, regional rules
- [Roadmap](../ROADMAP.md) — milestones from alpha to 1.0 and beyond
- [ADRs](adr/) — architecture decision records

## Building the site

```bash
pip install mkdocs-material mkdocs-mermaid2-plugin
mkdocs serve          # local preview at http://127.0.0.1:8000
mkdocs gh-deploy      # publish to GitHub Pages
```

## Status

Scaffold. Each page contains an outline and the key decisions already made in the
approved design; fill them in as the implementation lands.
