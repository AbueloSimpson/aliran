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
| `panel/` | Accounts, catalog, OPRF login (Node) |
| `broadcaster/` | Ingest → encrypted feed → swarm (Node) |
| `client/` | React Native phone + TV app |
| `docs/` | This documentation |

## Current status

This is an early scaffold. Runnable pieces: config + panel key generation. The
streaming pipeline, auth, and app UI are in progress — see the [Roadmap](../ROADMAP.md)
and each package's `README.md` for exactly what's implemented vs. stubbed.

## Next steps

- Understand the design → [Architecture](architecture.md) and [Security model](security-model.md)
- Run a real deployment → [Operator Guide](operator-guide.md) + [Configuration](configuration.md)
- Contribute → [CONTRIBUTING.md](../CONTRIBUTING.md), pick a Roadmap item
