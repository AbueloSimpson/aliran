# Operator Guide (self-hosting)

Run your own Aliran service. Everything is configuration — no code changes needed.

## Prerequisites

- Node.js 20+ on a Linux box (a cheap VPS or a home machine — no inbound ports needed).
- `ffmpeg` for the broadcaster.
- (Optional) Docker + Docker Compose.
- (Optional, DRM) an account with a multi-DRM vendor (BuyDRM/KeyOS, EZDRM, Axinom…).
- (Optional, geo) a MaxMind GeoLite2 database file.

## 1. Generate keys (panel)

```bash
cd panel && cp .env.example .env && npm install
node src/admin-cli.js init
```

This creates the panel signing key + OPRF key in a **gitignored** data directory and
prints the **panel public key** — you'll put this in the client config / service
descriptor. Back these keys up securely; losing the OPRF key locks everyone out.

## 2. Create accounts & streams

```bash
node src/admin-cli.js create-user alice
node src/admin-cli.js add-stream news --title "News 24" --category news
node src/admin-cli.js upload-art news poster ./art/news-poster.jpg
node src/admin-cli.js grant alice news
```

## 3. Run the panel

```bash
node src/index.js        # or: docker compose up panel
```

For availability run a **replica set** (threshold OPRF) — see
[configuration.md](configuration.md) and the HA notes.

## 4. Run the broadcaster

```bash
cd ../broadcaster && cp .env.example .env && npm install
# configure INPUT (rtmp listener for OBS, or an rtsp/hls/file URL) in .env
node src/index.js        # or: docker compose up broadcaster
```

## 5. Point the client at your panel

Build/brand the client with your **panel public key** (build-time config) or generate a
**service-descriptor QR** for runtime pairing. See [client-build.md](client-build.md).

## Operations

- **Backups:** the data dir (keys + cores). The OPRF/signing keys are critical.
- **Key rotation:** rotating the OPRF key requires user re-enrollment; document a runbook.
- **Monitoring:** watch panel login RPC, peer counts, lockouts.
- **Firewall:** outbound UDP only; set `relayOnly` to hide the origin IP.
