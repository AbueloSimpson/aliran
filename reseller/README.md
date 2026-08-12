# Aliran reseller panel (`reseller/`)

A standalone web panel where **resellers** activate and manage viewer accounts
without holding real admin power over your Aliran panel. It fronts the panel's
[admin API](../docs/reference.md): every account action a reseller takes becomes
a call to the real API, gated by this service's own **role hierarchy** and
**credit ledger**.

This service owns two things the panel does not:

- **The role hierarchy.** The panel has no admin roles — every panel admin is
  all-powerful. So the hierarchy lives here (**admin → co-admin → super
  reseller → reseller**), and this service talks to the panel as *one*
  dedicated admin.
- **The subscription clock.** The panel has no account expiry. This service
  tracks each account's expiry and disables lapsed ones on the panel (the
  expiry sweep). Credits are months: 1 credit = 1 month, flat.

Full concepts, both deployment topologies, and the bootstrap walkthrough are in
**[docs/reseller-panel.md](../docs/reseller-panel.md)**.

## Quick start

```sh
# from the repo root — reseller/ is a workspace
npm install

cd reseller
cp .env.example .env          # set PANEL_ADMIN_URL + PANEL_ADMIN_USER/PASS
node src/reseller-cli.js add-admin boss    # seed THE root admin (once)
npm start                     # control API + dashboard on 127.0.0.1:3330
```

On the **panel** host, create the dedicated admin this service signs in as:

```sh
node src/admin-cli.js add-admin reseller-svc   # in panel/ — asks for the password
```

The password is never an argument. Put the same password in `PANEL_ADMIN_PASS`. With
no terminal, pipe it in: `printf '%s\n' "$PW" | node src/admin-cli.js add-admin
reseller-svc`.

Then open `http://127.0.0.1:3330`, sign in as the root admin, and create
co-admins, super resellers, and resellers. From there they can mint credits and
activate accounts.

## CLI

```
node src/reseller-cli.js add-admin <name>        Seed THE root admin (refused if one exists)
                          list-principals [--role <r>]
                          remove-principal <name>
                          set-password <name>
                          mint <name> <amount>   Offline credit mint (bootstrap)
                          balance <name>
```

Everything past bootstrap happens through the dashboard/API, where the role
gates live.

## Dashboard language

The dashboard reads in **English or Spanish**. The `Language` control is on the
login card and in Settings, and the choice is kept per browser
(`localStorage`) — the login card needs a language before there is a principal
to hold a preference, so no API route or env variable is involved.

The catalog is `control-ui/i18n.js`: a plain script, no build step, no
dependency. It is deliberately separate from the viewer apps' `@aliran/i18n`
— that package is TypeScript for a bundler this dashboard does not have, and
`control-server.js` serves a flat `.html`/`.js`/`.css` whitelist. To add a
language, extend `LOCALES`, copy the `CATALOG.en` block, translate it and run
`npm run test:i18n` (section 6 guards this catalog). Details:
[docs/reseller-panel.md → Language](../docs/reseller-panel.md#language).

## Data (`DATA_DIR`, default `./data`)

```
secrets/principals.json   the hierarchy (Argon2id verifiers, roles, parents) — 0600
keys/control.json         the token-signing keypair — 0600
ledger/ledger.jsonl       append-only credit ledger (the durable audit trail)
accounts.json             viewer-account registry = the subscription clock
state/                    cached panel token + last reconcile report
```

## Deploy

Docker Compose runs this behind the `reseller` profile, so a plain `up -d`
never starts it:

```sh
docker compose --profile reseller run --rm reseller node src/reseller-cli.js add-admin boss
docker compose --profile reseller up -d
```

Bind loopback and put TLS in front — the dashboard is meant for third parties,
so an IP allowlist is the recommended extra layer. See
[deploy/Caddyfile.example](../deploy/Caddyfile.example) and
[docs/reseller-panel.md](../docs/reseller-panel.md).
