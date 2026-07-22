# Getting Started

Aliran has three audiences. Pick your path:

- **Operators** — run a streaming service → [Operator Guide](operator-guide.md)
- **Developers** — build/contribute → this page + [Architecture](architecture.md)
- **End users** — watch on the app → install the operator's APK and log in

## 5-minute developer tour

> Prerequisites: Node.js 20+, `ffmpeg`. (The Android app additionally needs the native
> toolchain — see [client-build.md](client-build.md).)

```bash
git clone https://github.com/AbueloSimpson/aliran
cd aliran
npm install                      # installs panel + broadcaster workspaces

# Panel (origin of truth)
cd panel
cp .env.example .env
node src/admin-cli.js init       # generate keys, prints the panel public key
node src/index.js                # start the panel node
```

In another terminal:

```bash
cd broadcaster
cp .env.example .env             # set PANEL_PUBKEY (from the panel output) + INPUT
npm install
node src/index.js
```

For the app, follow [client-build.md](client-build.md) to generate the native project,
set your panel public key in `client/config/service.json`, and build the APK.

## Where things live

| Path | What |
|------|------|
| `core/` | Shared crypto (`@aliran/core`): OPRF, Argon2id, sealing, tokens |
| `panel/` | Accounts, catalog, OPRF login, admin API + dashboard (Node) |
| `broadcaster/` | Ingest → encrypted feed → swarm; control API + UI (Node) |
| `repeater/` | Optional keyless regional super-peer (ciphertext mirror) |
| `sdk/` | `@aliran/player-sdk` — the headless viewer engine (Node + Bare) |
| `sdk/react-native/` | `@aliran/react-native` — `AliranBackend` + `<AliranVideo>` binding |
| `client/` | React Native phone + TV app (runs the SDK in a Bare worklet) |
| `tools/` | e2e test suites, desktop viewer, remote acceptance harness |
| `deploy/` | Docker Compose, systemd units, Caddy TLS recipe |
| `docs/` | This documentation |

## Current status

Pre-1.0, actively developed — the whole pipeline is verified end to end on real
infrastructure: the deploy pack on a VPS, live channels (pull and push ingest), and
the Android app (phone + TV) playing P2P over the public DHT. Every subsystem has an
e2e suite (`npm run test:sdk`, `test:admin-api`, `test:broadcaster-api`,
`test:repeater`, …) and `tools/acceptance-remote.mjs` proves a deployment from any
machine. Remaining before 1.0 (panel HA, the hardening/security-review pass):
see the [Roadmap](https://github.com/AbueloSimpson/aliran/blob/main/ROADMAP.md).

## Next steps

- Understand the design → [Architecture](architecture.md) and [Security model](security-model.md)
- Run a real deployment → [Operator Guide](operator-guide.md) + [Configuration](configuration.md)
- Contribute → [CONTRIBUTING.md](https://github.com/AbueloSimpson/aliran/blob/main/CONTRIBUTING.md), pick a Roadmap item
