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

## Working on the docs site

`docs/` is the source for the documentation site (MkDocs Material; diagrams use
Mermaid), published at <https://abuelosimpson.github.io/aliran/>.

```bash
pip install mkdocs-material mkdocs-mermaid2-plugin
mkdocs serve                  # local preview at http://127.0.0.1:8000
python -m mkdocs build --strict   # what CI runs — dead links fail the build
```

Add new pages to the `nav:` in [`mkdocs.yml`](mkdocs.yml), under the audience section
they belong to. Publishing is automatic: every push to `main` touching `docs/` or
`mkdocs.yml` rebuilds and deploys via
[`.github/workflows/docs.yml`](.github/workflows/docs.yml).

### Writing style — STE rules (required)

All prose in `docs/`, `docs/kb/`, and every `README.md` follows the
**ASD-STE100 (Simplified Technical English) writing rules**:

- One instruction per sentence. Keep sentences short (aim for 20 words or fewer
  in instructions, 25 in descriptions).
- Active voice, present tense. Say who does what.
- One approved term per thing — do not switch between synonyms for the same
  object (a channel is always a *channel*, never also a *stream* or *feed* in
  viewer-facing text).
- No long noun strings (three nouns or more in a row — break them up).

This is the writing-rules subset applied by hand with a project word list, not
formal certified STE (the honest note at the top of [`docs/README.md`](docs/README.md)
says so once, for the whole site). New or edited pages must follow these rules;
`CHANGELOG.md`, `docs/devlog.md`, code comments, and commit messages are exempt.

## Commit / PR

- Branch from `main`, open a PR with a clear description and testing notes.
- Reference related issues. Security-sensitive PRs: see [`SECURITY.md`](SECURITY.md).

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
