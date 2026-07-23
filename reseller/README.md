# Aliran reseller panel (`reseller/`)

A standalone web panel where **resellers** activate and manage viewer accounts
without holding real admin power over your Aliran panel. It fronts the panel's
[admin API](../docs/reference.md): every account action a reseller takes becomes
a call to the real API, gated by this service's own **role hierarchy** and
**credit ledger**.

Two things this service owns that the panel does not:

- **The role hierarchy.** The panel has no admin roles — every panel admin is
  all-powerful. So the hierarchy lives here (**admin → co-admin → super reseller
  → reseller**), and this service talks to the panel as *one* dedicated admin.
- **The subscription clock.** The panel has no account expiry. This service
  tracks each account's expiry and disables lapsed ones on the panel (the expiry
  sweep). Credits are months: 1 credit = 1 month, flat.

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
node src/admin-cli.js add-admin reseller-svc <password>   # in panel/
```

Then open `http://127.0.0.1:3330`, sign in as the root admin, and create
co-admins / super resellers / resellers, mint credits, and let them activate
accounts.

## CLI

```
node src/reseller-cli.js add-admin <name>        Seed THE root admin (refused if one exists)
                          list-principals [--role <r>]
                          remove-principal <name>
                          set-password <name>
                          mint <name> <amount>   Offline credit mint (bootstrap)
                          balance <name>
```

Everything past bootstrap happens through the dashboard/API, where the role gates
live.

## Data (`DATA_DIR`, default `./data`)

```
secrets/principals.json   the hierarchy (Argon2id verifiers, roles, prefixes) — 0600
keys/control.json         the token-signing keypair — 0600
ledger/ledger.jsonl       append-only credit ledger (the durable audit trail)
accounts.json             viewer-account registry = the subscription clock
state/                    cached panel token + last reconcile report
```

## Deploy

Docker Compose behind the `reseller` profile (so a plain `up -d` never starts it):

```sh
docker compose --profile reseller run --rm reseller node src/reseller-cli.js add-admin boss
docker compose --profile reseller up -d
```

Bind loopback and put TLS in front — the dashboard is meant for third parties,
so an IP allowlist is the recommended extra layer. See
[deploy/Caddyfile.example](../deploy/Caddyfile.example) and
[docs/reseller-panel.md](../docs/reseller-panel.md).
