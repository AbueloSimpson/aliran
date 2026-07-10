# Concepts

## Why peer-to-peer

Aliran has no central media servers. Viewers replicate the stream and **re-seed** it to
each other, so distribution capacity grows with the audience instead of costing more.

## The Holepunch/Pear stack

- **Bare** — a small, embeddable JavaScript runtime (what Pear is built on). Runs on
  desktop and mobile. In Aliran it runs *inside* the Android app via
  `react-native-bare-kit`.
- **Hyperswarm** — peer discovery + encrypted connections over a DHT, with NAT
  hole-punching (works behind firewalls).
- **Hypercore** — append-only, signed log. The basis for everything below.
- **Hyperbee** — a B-tree (key/value store) on a Hypercore. Used for the account DB +
  catalog.
- **Hyperdrive** — a filesystem on Hypercores. Used for stream segments + assets.
- **Corestore** — manages many Hypercores.

> Note: **Pear the runtime cannot be packaged as an Android APK.** Aliran ships the
> Holepunch *stack* inside a React Native app (the way Keet does), not Pear itself.

## Glossary

| Term | Meaning |
|------|---------|
| **Panel** | Origin of truth: signed account DB + catalog + OPRF login |
| **Broadcaster** | Node that ingests a source and seeds the encrypted feed |
| **Client** | The Android app; plays and re-seeds |
| **Feed** | The encrypted Hyperdrive carrying a stream's HLS/CENC segments |
| **OPRF** | Oblivious PRF — makes password login brute-force-resistant |
| **Entitlement token** | Panel-signed JWT proving a user may play a stream (DRM/geo) |
| **Service descriptor** | Config bundle (panel pubkey + branding) a client connects to |
