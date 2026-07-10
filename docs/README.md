# Aliran Documentation

Aliran is a self-hostable, peer-to-peer OTT streaming platform on the Holepunch/Pear
stack. This folder is the source for the docs site (publishable with Docusaurus or
MkDocs Material; diagrams use Mermaid).

## Contents

- [Concepts](concepts.md) — P2P / Pear / Bare primer, glossary
- [Architecture](architecture.md) — the three components and how bytes/keys flow
- [Security model](security-model.md) — threat model, auth, brute-force, DRM, geo, **and honest limits**
- [Operator guide](operator-guide.md) — install, generate keys, run panel + broadcaster, HA
- [Configuration](configuration.md) — full config reference for every component
- [Content management](content-management.md) — catalog, metadata, assets, DRM, geo, VOD
- [Client build](client-build.md) — build the Android (phone + TV) app
- [User management](user-management.md) — accounts, passwords, devices, sessions
- [Reference](reference.md) — admin-cli, panel RPC, schemas
- [Legal & compliance](legal-compliance.md) — content rights, DRM licensing, regional rules
- [ADRs](adr/) — architecture decision records

## Status

Scaffold. Each page contains an outline and the key decisions already made in the
approved design; fill them in as the implementation lands.
