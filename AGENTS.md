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

- **Vercel** — docs site via `vercel.json` (`mkdocs build --strict`).
- **Render** — `render.yaml` blueprint; deploys the reseller only.
- **GitHub Actions** — `.github/workflows/app-release.yml`; on a `v*` tag it builds
  the branded release APK + Linux desktop player and attaches them to a Release.
  Lint workflow edits with `actionlint` before pushing (a job `name` may not use
  the `runner` context, for example).

## State that is easy to lose

- `panel/data` holds the panel keypair, pairing code, admins and the DB. Back it up;
  if it is lost the panel must be re-initialized (`docker compose run --rm panel
  node src/admin-cli.js init`) and the broadcaster rewired to the new
  `PANEL_PUBKEY`/`PUBLISHER_KEY`.
- `panel/.env`, `broadcaster/.env` and their `data/` dirs hold live credentials and
  are gitignored. Never commit them.
