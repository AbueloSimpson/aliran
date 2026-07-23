# Reseller panel

The reseller panel (`reseller/`) lets **third-party resellers** create and manage
viewer accounts on your service without holding real admin power over your
[panel](operator-guide.md). It is a standalone HTTP service with its own
dashboard that sits *in front of* the [panel admin API](reference.md): every
account a reseller activates, renews, suspends, or deletes becomes a call to that
API — but only after passing this service's **role hierarchy** and **credit
ledger** checks.

It is optional and self-contained, like the [repeater](repeater.md) and
[VOD library](vod-library.md): a separate workspace, its own store, its own
Docker Compose profile. It can run on the panel host or on a different machine.

## Why it exists — two gaps it fills

The panel deliberately keeps two things simple, and the reseller panel supplies
what a reselling business needs on top:

1. **The panel has no admin roles.** Every panel admin can do everything —
   there is no scoped "reseller" admin to hand out. So the whole hierarchy lives
   in the reseller panel, which authenticates to the panel as **one** dedicated
   full-privilege admin account. Resellers never get panel credentials.
2. **The panel has no account expiry.** Panel accounts are active until someone
   disables them. Subscriptions need a clock, so the reseller panel owns it:
   it records each account's expiry and, when a subscription lapses, disables the
   account on the panel (the **expiry sweep**).

## Roles

A strict hierarchy, top to bottom. Each principal has a parent; a principal can
only ever act within its own subtree.

| Role | Can | Notes |
|---|---|---|
| **Admin** | Everything. Mints credits. The only role that can create/delete **co-admins**. | Exactly one *root* admin, seeded by the CLI, undeletable. |
| **Co-admin** | A full admin clone — including minting — so you can hand out a second all-powers login with its own audit trail. | Cannot manage other co-admins or the root (root-only territory). |
| **Super reseller** | Creates resellers under itself, funds them from its **own** balance, manages only its own subtree. | Needs a unique prefix. |
| **Reseller** | Activates / renews / suspends / deletes viewer accounts under its own prefix, spending its own balance. | Needs a unique prefix. |

## Credits

Credits are **months**: **1 credit = 1 month**, flat (the month length is
`DAYS_PER_MONTH`, default 31). The number of devices an account allows
(`maxDevices`) is a setting within each reseller's limit — it does **not** change
the price.

- **Minting** — only admins and co-admins create credits (from nothing). Even an
  admin's *transfer* debits their own balance, so the ledger always shows where
  every credit came from.
- **Allocating down** — a super reseller funds its resellers from its own
  balance (an atomic paired debit/credit). Reclaim pulls credits back, capped at
  what the child still holds.
- **Spending** — activating or renewing an account costs `months` credits,
  debited from the actor. Admin-tier account operations are free (and write no
  ledger entry — they are operator actions, not part of the credit economy).
- **Refunds** — deleting a paid account refunds `floor(remaining months)` to the
  account's owner. Admin deletes refund nothing.

The ledger is an **append-only** file — it is the durable audit trail (the
panel's own activity feed is in-memory and cleared on restart). Balances are
always derived from it, never stored, so they can never drift.

## Trials

Resellers can start **free, time-boxed trial accounts** (`TRIAL_HOURS`, default
24), capped per reseller per day (`trialDailyCap`). A trial is a normal viewer
account with a short expiry; the expiry sweep disables it like any lapsed
account. **Renewing a trial converts it to paid** — same username and password,
coverage starting from now — the natural upsell.

## Account namespacing

Every viewer account a reseller creates is named
`<GLOBAL_PREFIX>.<resellerPrefix>.<name>` (admins, having no prefix, create
directly under `<GLOBAL_PREFIX>.<name>`). This guarantees a reseller's accounts
can never collide with operator-created panel users or with another reseller's —
and the reseller only ever sees and manages accounts inside its own namespace.

## Keeping panel and ledger in sync

Every account operation is **fail-closed**: the panel is called first, and the
local ledger + registry commit only if the panel accepted it. A rejected
activation (out of credits, name taken) leaves *nothing* behind — no panel user,
no ledger line.

Two background loops keep the two sides aligned:

- **Expiry sweep** (`SWEEP_INTERVAL_SEC`, default 300 s) — disables accounts
  whose subscription has lapsed. Its work list is derived from expiry each tick,
  so if the panel is briefly unreachable it simply retries next tick (and backs
  off to 15-minute checks until the panel returns).
- **Reconcile sweep** (`RECONCILE_INTERVAL_SEC`, default 1 h) — diffs the panel's
  users under your prefix against the local registry and reports divergences
  (an orphaned panel account, a status mismatch). With `RECONCILE_REPAIR=1` it
  also fixes them, always letting the local subscription clock win; with the
  default `0` it only reports (to `state/reconcile.json` and the dashboard).

## Deployment topologies

The reseller panel reaches the panel admin API at `PANEL_ADMIN_URL`. Two shapes:

**Single box** — reseller panel on the same host as the panel. `PANEL_ADMIN_URL`
is loopback (`http://127.0.0.1:3210`); nothing about the panel is exposed.

```
┌─ host ─────────────────────────────────┐
│  panel :3210 (loopback)  ◄── reseller   │
│                              panel :3330 (behind TLS) ──► resellers
└────────────────────────────────────────┘
```

**Two boxes** — reseller panel on separate hardware (its own trust boundary, its
own scaling). The panel's admin API must be reachable from the reseller box, so
publish it over TLS **and restrict it to that box's IP** (the reseller panel is
the only client — an IP allowlist is a real second gate that, unlike HTTP Basic
auth, also protects `/api/*`; see below).

```
┌─ panel box ───────────┐        ┌─ reseller box ──────────┐
│ panel :3210            │◄──TLS──│ reseller panel :3330    │──► resellers
│ (published, IP-allow-  │  admin │ (behind TLS)            │
│  listed to reseller box)│  API  └─────────────────────────┘
└───────────────────────┘
```

## Exposing the dashboard safely

Like the other dashboards, the reseller panel binds `127.0.0.1` and speaks plain
HTTP — put [Caddy](kb/public-dashboards.md) in front for TLS. Because it is
**meant to be used by third parties**, the strong recommendation is to add an
**IP allowlist** in front of it (and, on the two-box setup, in front of the
panel admin API it calls). `deploy/Caddyfile.example` carries a worked
`reseller.example.com` block.

Note the same collision the other dashboards have: HTTP has one `Authorization`
header, and the dashboard already uses it for its own Bearer login, so a Caddy
`basic_auth` gate must exclude `/api/*` (it would clobber the Bearer token). The
example handles this; an IP allowlist is the layer that actually protects the
API.

## Bootstrap walkthrough

1. **On the panel host**, create the dedicated admin the service signs in as
   (never a human admin's credentials):

   ```sh
   cd panel && node src/admin-cli.js add-admin reseller-svc <password>
   ```

2. **Configure** `reseller/.env` — `PANEL_ADMIN_URL`, `PANEL_ADMIN_USER=reseller-svc`,
   `PANEL_ADMIN_PASS`, and your `GLOBAL_PREFIX`.

3. **Seed the root admin** and start:

   ```sh
   cd reseller
   node src/reseller-cli.js add-admin boss     # once; a second root is refused
   npm start                                    # or: docker compose --profile reseller up -d
   ```

4. **Sign in** at `http://127.0.0.1:3330` as `boss`, mint yourself credits, and
   create the hierarchy: co-admins for staff, super resellers for distributors,
   resellers for the front line. Fund them, and they activate accounts.

Any channels you want every account to receive automatically should be behind an
[autoGrant source](content-management.md) on the panel (the panel grants those at
account creation); a reseller can additionally attach individual channels to an
account from the dashboard's grants picker.

## Reference

The reseller control API is documented in the [Reference](reference.md#reseller-panel-api).
Its source lives in [`reseller/`](https://github.com/AbueloSimpson/aliran/tree/main/reseller);
the [README](https://github.com/AbueloSimpson/aliran/blob/main/reseller/README.md)
is the operator quick start.
