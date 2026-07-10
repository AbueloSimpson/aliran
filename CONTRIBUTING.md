# Contributing to Aliran

Thanks for your interest! Aliran is an open-source, self-hostable P2P OTT platform.

## Repository layout

```
panel/         Node — signed account DB + catalog + OPRF login (origin of truth)
broadcaster/   Node — ingest -> encrypted Hyperdrive feed -> Hyperswarm
client/        React Native (react-native-tvos) — Android phone + TV app
docs/          Documentation site sources (Markdown, Mermaid diagrams)
```

`panel` and `broadcaster` are npm workspaces (run `npm install` at the repo root).
`client` is a separate React Native project with its own native toolchain — see
[`client/README.md`](client/README.md).

## Development setup

1. `npm install` (root) — installs `panel` + `broadcaster` deps.
2. Copy each package's `.env.example` to `.env` and fill in values.
3. `node panel/src/admin-cli.js init` to generate local dev keys (gitignored).

## Guidelines

- **Never commit secrets or keys.** The `.gitignore` blocks `.env`, `keys/`,
  `store/`, `*.key`, GeoIP DBs, etc. Double-check `git status` before committing.
- **Crypto changes** (OPRF, key-wrapping, Argon2 params, token signing) get extra
  scrutiny — open an issue to discuss first, and prefer vetted libraries over
  hand-rolled primitives.
- Match the existing code style; keep modules small and focused.
- Add/adjust docs under `docs/` for any user-facing change.
- Record significant architectural decisions as ADRs in `docs/adr/`.

## Commit / PR

- Branch from `main`, open a PR with a clear description and testing notes.
- Reference related issues. Security-sensitive PRs: see [`SECURITY.md`](SECURITY.md).

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
