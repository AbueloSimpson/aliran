# 1. Record architecture decisions

Date: 2026-07-10

## Status

Accepted

## Context

Aliran makes several non-obvious, security-critical design choices. We want a durable
record of *why*, so future contributors don't re-litigate settled trade-offs.

## Decision

We will keep Architecture Decision Records (ADRs) in `docs/adr/`, one per decision,
numbered sequentially. Key decisions already made (to be written up as their own ADRs):

- **0002** — Ship the Holepunch stack inside React Native (not Pear-as-APK).
- **0003** — Single-writer, panel-signed Hyperbee as the account/catalog origin of truth.
- **0004** — OPRF-based login for brute-force resistance (panel required for new logins).
- **0005** — Session policy: returning users offline, new logins online; reject
  fully-offline login.
- **0006** — HLS-over-Hyperdrive for live (lean on native HLS live playback).
- **0007** — ~~DRM and geo-locking as optional, provider-pluggable modules.~~
  **Superseded (2026-07):** both were dropped from the roadmap. The platform ships
  honest access control (encrypted feeds, per-user sealed keys, key rotation) and
  deliberately no DRM or geo-restriction — see the security model.

## Consequences

Contributors can understand the reasoning behind the design and propose changes against
a recorded rationale rather than guesswork.
