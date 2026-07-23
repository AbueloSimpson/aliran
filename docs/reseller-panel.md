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
| **Super reseller** | Creates resellers under itself, funds them from its **own** balance, manages only its own subtree. | |
| **Reseller** | Activates / renews / suspends / deletes its own viewer accounts, spending its own balance. | |

## Credits

Credits are **months**: **1 credit = 1 month**, flat (the month length is
`DAYS_PER_MONTH`, default 31). The number of devices an account allows
(`maxDevices`) does **not** change the price — and it is not a reseller choice
at all: see the device policy below.

## Device policy — admin-set, inherited

How many simultaneous devices an account allows is **policy, owned by the admin
tiers**, and it **inherits down the hierarchy**: a principal without an
explicitly set `maxDevicesLimit` uses its parent's effective value (the root's
fallback is `MAX_DEVICES_LIMIT_DEFAULT`). Resolution is **live** — change a
super's value and every reseller under it that has no explicit value of its own
follows instantly, no cascade writes — so a subtree stays consistent by
construction.

- **Admins/co-admins** set (or clear back to *inherit*) the value per principal
  in the **Limits** dialog or via the API (`maxDevicesLimit: null` = inherit).
  Supers see it read-only there; they still tune trial caps.
- **New accounts and trials simply receive** the creator's effective policy
  value — resellers cannot pass `maxDevices` (the API rejects it loudly).
  Every principal view reports the effective value plus a
  `maxDevicesLimitInherited` flag.
- **Admin tiers keep a per-account override** (`POST
  /api/accounts/:acct/max-devices`, or `maxDevices` on their own activations) —
  an operator exception, not part of the reseller flow.
- A policy change applies to **future** activations; existing accounts keep
  their value until an admin overrides them (the reconcile sweep keeps the
  panel matching each account's registry value either way).

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

## Automated credit top-ups (payment webhook)

Minting by hand does not scale to selling credits. Set `WEBHOOK_SECRET` (a long
random value, 32+ chars — it is the *only* thing authenticating a mint) and the
service enables `POST /api/webhooks/credits`: your payment provider's success
handler (or your own shop backend) posts

```json
{ "id": "<unique event id>", "to": "<principal>", "amount": 10, "note": "order #1001" }
```

and the credits land as a normal `MINT` ledger line with actor `webhook` and the
event id in the note — the audit trail stays complete. The security model is
the Stripe-webhook shape:

- **Signed**: `x-topup-signature` = hex `HMAC-SHA256(secret, "<timestamp>.<raw body>")`
  with `x-topup-timestamp` (unix seconds). Constant-time comparison; a
  timestamp outside ±5 minutes is rejected, which kills replays outside the
  window.
- **Idempotent**: `id` is the delivery key. Payment providers *retry* webhooks
  on timeouts — a repeated `id` answers `200 {duplicate:true}` and mints
  nothing, so a retry can never double-credit.
- **Fail-dark**: without `WEBHOOK_SECRET` the route answers 404,
  indistinguishable from not existing.

Signing example (node — the same five lines work in any language):

```js
const ts = Math.floor(Date.now() / 1000)
const body = JSON.stringify({ id: payment.id, to: buyer, amount: months })
const sig = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(`${ts}.${body}`).digest('hex')
await fetch('https://resellers.example.com/api/webhooks/credits', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-topup-timestamp': String(ts), 'x-topup-signature': sig },
  body
})
```

Use your payment provider's *own* event id (e.g. the Stripe `event.id`) as
`id`, and only fire on a **final** payment state. Expose the endpoint the same
way as the dashboard (TLS via Caddy or the Cloudflare Tunnel — never plain
HTTP across the internet); the System card on the Overview shows whether the
webhook is enabled.

## White-labeling

The dashboard white-labels without touching the source:

- **`BRAND_NAME`** — replaces "Aliran reseller" in the login card, the sidebar
  and the page title (first word bold, the rest in the accent tone, same as the
  stock brand).
- **`BRAND_THEME_FILE`** — path to a JSON file overriding any of the **11
  shared theme tokens** (`bg`, `panel`, `panel-2`, `border`, `text`, `muted`,
  `accent`, `accent-dim`, `danger`, `ok`, `warn`) with 6-digit hex values:

  ```json
  { "accent": "#F59E0B", "accent-dim": "#B45309" }
  ```

The overrides are served as `/branding.css` and layered **after** the
stylesheet's shared theme block, so the byte-identical block the theme test
enforces is untouched — this is the S19 white-label seam, wired up. The
favicon dot follows the (possibly overridden) accent automatically. Unknown
tokens and non-hex values in the file are ignored; edits apply on the next
page load, no restart needed.

## Trials

Resellers can start **free, time-boxed trial accounts** (`TRIAL_HOURS`, default
24), capped per reseller per day (`trialDailyCap`). A trial is a normal viewer
account with a short expiry; the expiry sweep disables it like any lapsed
account. **Renewing a trial converts it to paid** — same username and password,
coverage starting from now — the natural upsell.

## Account names and ownership

Viewer account names are **plain panel usernames** — no prefixes. Names are a
global, first-come-first-served space: if a reseller picks a name an existing
panel user already has, the panel's own "exists" error surfaces and they pick
another. Ownership never depends on the name — the reseller panel's registry
records which principal owns each account, and a reseller can only ever see and
operate on accounts the registry says are theirs. Operator-created panel users
are invisible to the reseller panel entirely.

The accounts list is built for density: search (name **or** owner,
case-insensitive), status filters, and sorting (name, expiry, created date,
status, owner — ascending or descending) all run **server-side**. The dashboard
shows **50 per page** with prev/next and a jump-to-page selector, so the table
behaves identically at 10 accounts or 10,000, and its rows reflow into stacked
cards on a phone. Admins and super resellers can click any owner to drill into
just that reseller's accounts.

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
- **Reconcile sweep** (`RECONCILE_INTERVAL_SEC`, default 1 h) — checks every
  account in the registry against the panel and reports divergences (a status
  mismatch, an account missing panel-side). Creates are additionally bracketed
  by an **intent journal** — recorded before the panel call, cleared after the
  local commit — so a crash in that window leaves a stale intent the sweep
  chases: if the panel user exists but was never committed locally, that orphan
  is disabled (never deleted) and reported. With `RECONCILE_REPAIR=1` repairs
  apply, always letting the local subscription clock win; with the default `0`
  it only reports (to `state/reconcile.json` and the dashboard).

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

### No public IP? Cloudflare Tunnel

When the reseller box sits behind NAT/CGNAT or a firewall you cannot open —
but your resellers still need to reach their accounts from the internet —
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
is the supported alternative to Caddy. `cloudflared` runs next to the service
and makes an **outbound-only** connection to Cloudflare's edge; Cloudflare
terminates TLS on your hostname and proxies requests down the tunnel. No
inbound port ever opens, and the origin IP is never published. Everything this
setup uses — the tunnel itself and the `CF-Connecting-IP` header — is on
Cloudflare's **free plan** (a free account with your domain on it is enough;
the optional extras below are free-tier too: Access up to 50 users, and the
free allowance of WAF custom rules).

`deploy/cloudflared.compose.example.yml` is the worked example, and it uses an
**isolated compose network**: the reseller service and `cloudflared` share a
private bridge network, and the dashboard port is **never published to the
host** — the tunnel is structurally the only way in. The flow is: create a
remotely-managed tunnel in Zero Trust → copy its token into `reseller/.env` as
`TUNNEL_TOKEN` → add a public hostname pointing at `http://reseller:3330` (the
compose service name) → `docker compose --project-directory . -f
deploy/cloudflared.compose.example.yml up -d --build` (instead of
`--profile reseller`; same image and data volume).

What makes it as secure as the Caddy path:

- **`TRUST_PROXY_HEADER=cf-connecting-ip`** (preset in the example). Behind any
  proxy every connection reaches the service from the proxy's socket address,
  so the login lockout's `username|ip` key would treat all your resellers as
  one client — one abuser could lock a victim's username for everybody. With
  the header declared, the throttle keys on the real client IP that Cloudflare
  stamps on each request. The usual caveat — never trust the header if the
  port is also reachable directly — is satisfied **by construction** here:
  nothing outside the compose network can reach the port to spoof it, and
  Cloudflare's edge overwrites `CF-Connecting-IP` on every proxied request, so
  it cannot be smuggled through the front door either. (Running behind
  Caddy/nginx instead? The same option takes `x-forwarded-for`; the rightmost
  list entry — the one the trusted proxy appended — is used, and the
  direct-reachability caveat is then yours to enforce.)
- **`CONTROL_HOST=0.0.0.0` is correct *inside this topology*** (also preset):
  it binds the container's interfaces on the private network, which is not
  reachable from the host's LAN because no port is published. On any topology
  where the port IS published, keep the loopback default.
- **IP allowlists move to Cloudflare.** The origin only ever sees the tunnel,
  so `remote_ip`-style rules belong in a Cloudflare WAF rule — or put
  **Cloudflare Access** in front of the hostname. Access authenticates the
  browser with its own cookie, so unlike HTTP `basic_auth` it does **not**
  collide with the dashboard's `Authorization: Bearer` API login and can cover
  `/api/*` too. Either way the dashboard's own argon2 + lockout login remains
  the application gate.

The same pattern works for the panel/broadcaster dashboards, but those are
single-operator surfaces — the SSH tunnel or Caddy answers are usually enough.
The reseller panel is the one built for third parties, which is why the tunnel
option is documented here.

## Bootstrap walkthrough

1. **On the panel host**, create the dedicated admin the service signs in as
   (never a human admin's credentials):

   ```sh
   cd panel && node src/admin-cli.js add-admin reseller-svc <password>
   ```

2. **Configure** `reseller/.env` — `PANEL_ADMIN_URL`, `PANEL_ADMIN_USER=reseller-svc`,
   and `PANEL_ADMIN_PASS`.

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
