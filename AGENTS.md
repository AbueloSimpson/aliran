# AGENTS.md — Aliran repository notes

Repo-specific knowledge for agents working in this codebase.

## Layout and what can run where

- npm workspaces at the root: `core`, `panel`, `broadcaster`, `repeater`,
  `library`, `reseller`, `epg`, `sdk`, `i18n`, `mcp`, `tools`, `desktop`.
- `client/` is **deliberately NOT an npm workspace** — it carries its own
  react-native-tvos toolchain. The root `npm ci` never installs it. Install with:
  `npm ci --prefix client --legacy-peer-deps` (a plain `npm ci` dies with ERESOLVE).
- Deployability:
  - **UDP + DHT, needs hole-punching + a stable identity** → VPS / own hardware:
    `panel`, `broadcaster`, `repeater`, `library`, `epg`. These cannot run on a
    managed PaaS (no inbound UDP).
  - **Pure outbound HTTP** → any PaaS: `reseller`.
  - **Static** → Vercel/any static host: the MkDocs docs site.
  - `mcp` is stdio transport.

## Build gotchas

- The branded Android app is built by `node tools/brand.mjs <brand>`. A bare brand
  id resolves under `client/brands/<id>` — a brand must live there (beside the
  shipped `sunburst` example), not at repo-root `brands/`.
- `client/src/worklet.ts` imports `../backend/app.bundle.js`, which is generated
  and gitignored. Run `npm --prefix client run bundle-backend` before any Android
  build or the release JS bundle task fails to resolve the module.
- `brand.mjs` refuses a `signing.json` whose keystore file is missing. The keystore
  is gitignored; in CI, restore it from a secret or delete `signing.json` so the
  build falls back to the public debug keystore.
- Gradle builds take ~8-9 minutes; a failure before that is almost always a
  missing generated file or missing deps, not a code error.

## Verification commands

```bash
node tools/i18n-test.mjs                 # locale parity/placeholders/plurals — RESULT: PASS
node tools/brand.mjs somalistream --no-build   # validate brand + emit res overlay (no SDK needed)
curl -s localhost:3210/healthz           # panel liveness
curl -s localhost:3310/healthz           # broadcaster liveness
```

## Deploy surfaces

- **Vercel** — docs site via `vercel.json` (`mkdocs build --strict`). Live at
  https://aliran-somalistream-docs.vercel.app, linked to the repo for auto-deploy.
- **Render** — `render.yaml` blueprint; deploys the reseller only. Live at
  https://aliran-reseller.onrender.com (service `srv-dbqkielbedkc73dtndm0`),
  repo-linked with auto-deploy. Two settings are load-bearing:
  `CONTROL_PORT=10000` (Render routes the URL to `$PORT`, not 3330 — without it the
  deploy ends `update_failed` after a clean build) and `RESELLER_ADMIN_USER`/`_PASS`
  (the free plan's `/data` is ephemeral; `startReseller()` reseeds a root admin on
  boot). Create/update via the Render API with the `RENDER_API_KEY` secret.
- **GitHub Actions** — `.github/workflows/app-release.yml`; on a `v*` tag it builds
  the branded release APK + Linux desktop player and attaches them to a Release.
  Lint workflow edits with `actionlint` before pushing (a job `name` may not use
  the `runner` context, for example).

## GitHub tokens

- Two tokens exist. The `fork` remote carries a **classic PAT** (`repo`, `workflow`,
  `write:packages`) — it **can** open pull requests. The `origin` remote's `ghu_`
  token is dead (`Bad credentials`), and `$GITHUB_TOKEN` is a GitHub **App**
  installation token that cannot open PRs. Use the classic PAT for the PR API.
- The token account (`tokexperiment090-arch`) is a **collaborator, not a maintainer**,
  on upstream `AbueloSimpson/aliran` — it can open a PR from the fork but cannot push
  branches to upstream. Land work via PR:
  https://github.com/AbueloSimpson/aliran/pull/1

## Branded-app key correctness

- The Android/desktop artifacts bake `client/brands/<id>/service.json`'s `panelPubKey`
  (the workflow copies it to `desktop/config/service.json`). That file is **tracked**,
  so if the panel is re-initialized, the committed key goes stale and every shipped
  build silently pairs with nothing. After a re-init, update the brand descriptor to
  the new key (read it from the panel's `/data/keys/signing.json` or its boot log
  `Panel public key:` line) and cut a new release.
- Verify a build by extracting the artifact, not the source: the APK's
  `assets/index.android.bundle` and the AppImage's `resources/config/service.json`
  must contain the live key. The live pairing code is a pure function of the key
  (`pairingCode(key)`, in `core/pairing.js`) and is printed by the panel at boot.

## The panel identity is the whole deployment — back it up

- The panel keypair in `panel-data:/data/keys` (`signing.json`, `oprf.key`,
  `publisher.json`) is what every app pins. Lose it and every shipped app is dead
  until a rebuild. On this Agent Canvas runtime the sandbox **recycles and wipes the
  Docker volume** — it has happened twice. Treat the identity as something to copy
  off-box immediately after any `init`.
- Backups live in two places: `deploy/backup.sh` (cold tar of the volume) and the
  fork's encrypted Actions secrets — `ALIRAN_PANEL_DATA_B64` (base64 of the `/data`
  tar) plus the admin passwords. Push a fresh one with
  `deploy/free-vm/push-identity.sh`.
- Free hosts that can actually run the P2P services (inbound UDP + persistent
  identity) are **free VMs**, not PaaS: Oracle Always Free (Ampere A1) or GCP
  e2-micro. `deploy/free-vm/bootstrap.sh` stands the stack up on one and restores
  the identity; the restore path is verified (same key, same pairing code).

## State that is easy to lose

- `panel/data` holds the panel keypair, pairing code, admins and the DB. Back it up;
  if it is lost the panel must be re-initialized (`docker compose run --rm panel
  node src/admin-cli.js init`) and the broadcaster rewired to the new
  `PANEL_PUBKEY`/`PUBLISHER_KEY`.
- `panel/.env`, `broadcaster/.env` and their `data/` dirs hold live credentials and
  are gitignored. Never commit them.
