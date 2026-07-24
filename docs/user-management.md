# User Management

All account operations are performed with the panel's `admin-cli` or the admin HTTP
API/dashboard — both wrap the same shared ops (the panel is the single writer of the
signed account DB). See [reference.md](reference.md) for the full command/endpoint list.

## Accounts & passwords

```bash
admin-cli create-user alice           # prompts for a password; stores salt + verifier
admin-cli set-password alice          # rotate a password (re-seals grants, revokes sessions)
admin-cli grant alice news            # entitle a user to a stream (wraps the key)
admin-cli revoke alice news           # remove an entitlement
admin-cli set-status alice disabled   # disable an account (revokes sessions)
admin-cli delete-user alice           # remove the account record entirely
admin-cli list                        # list users / streams
```

Passwords are never stored — only an Argon2id verifier + OPRF-bound wrapped keys. See
[security-model.md](security-model.md).

Deleting a user removes the record — and with it every sealed grant and device
enrollment — from the signed DB. Session tokens that were already issued keep
validating **offline** until they expire (inherent to signed tokens); online checks
and any future login fail immediately.

## Channel packages (bouquets)

Per-stream grants stop scaling somewhere around a few dozen channels. A **package**
is a named bundle ("Basic", "Sports") granted as one unit:

```bash
admin-cli add-package basic --label "Basic" --members "news-24, kids-tv" --default
admin-cli add-package sports --members "category:Deportes, espn-*"
admin-cli set-user-packages alice basic,sports    # replace alice's package list
admin-cli show-package sports                     # members + the channels they resolve to now
admin-cli remove-package sports                   # grants only it covered are removed
```

(The CLI package commands need the store — run them with the panel stopped, or use
the dashboard **Packages** tab / admin API against the live panel.)

Members can be explicit stream ids, **id globs** (`sports-*`, the publisher-scope
matcher), or selectors — `category:<slug>` (a parent slug covers its `Parent/Child`
rails) and `source:<name>` (channels imported by that remote source). Selectors
resolve against the catalog **at reconcile time**, so a newly tagged, imported or
created channel joins the bouquet by itself; an explicit id may name a stream that
doesn't exist yet and materializes when it is added.

Because a grant is a **sealed key**, not an ACL, a package cannot be checked at
request time — every package change is *materialized* into per-user sealed grants
immediately (assignment, member edits, package removal, stream add/retag/delete,
source syncs, and panel boot all reconcile). Clients notice new keys at their next
login, exactly like a manual grant; **no client, SDK or wire change** is involved.

Grants carry **provenance**: `manualGrants` (granted one-by-one) vs `packages`
(assigned bouquets) — the dashboard Users tab shows package chips, manual chips and
source auto-grant chips distinctly. The rules:

- **Revoking a single stream removes the manual entitlement.** If one of the user's
  packages still covers it, the grant is re-sealed in the same request — access is
  then attributed to the package alone (the CLI says so instead of claiming a revoke).
- **Removing a package (or a member) removes only what nothing else covers** —
  manual grants, other packages, and auto-grant source channels always survive.
- **`default` packages** are assigned to every *newly created* user (beside the
  source auto-grant hook, which keeps working unchanged). Flipping `default` later
  never touches existing users.
- **A source with auto-grant OFF can be package-governed** (`source:<name>` member):
  only holders get its channels, and they follow the feed as it drifts. Turning a
  source's auto-grant off converges formerly-auto grants away on the next reconcile
  unless a package or manual grant covers them.
- Revocation stays **cooperative**: removing sealed keys stops future logins from
  recovering them, but a client that already unsealed a key needs a stream-key
  rotation for a hard lockout (same caveat as any revoke).

Upgrading a pre-package deployment migrates automatically at the first panel boot:
every existing grant is adopted as a *manual* grant — except channels owned by an
auto-grant source, which stay attributed to the source engine — so nothing a user
already had is ever revoked by the upgrade.

## Devices

```bash
admin-cli set-max-devices alice 2     # concurrent device limit
admin-cli list-devices alice          # enrolled devices (id, label, issued/expiry)
admin-cli logout-device alice <deviceId>   # drop ONE enrollment (see below)
admin-cli logout-all alice            # bump tokenVersion -> forces re-login everywhere
```

Device limits are enforced at login (the panel serializes count + add). A logged-out
device with a still-valid cached session keeps working until its next panel contact or
until the session TTL expires (enforcement latency = TTL).

**Per-device logout is cooperative session hygiene, not content protection.** It
removes the enrollment *without* bumping `tokenVersion` (so the user's other devices
stay logged in). The SDK's online check (`sessionLive`) sees the device is gone from
the replicated record and drops that client to the login screen — but a hostile
client keeps its cached token and any stream keys it already unsealed. Actually
revoking access = revoke the grant(s) and rotate the stream key.

## Sessions

- On successful online login the client seals stream keys + a panel-signed session
  token (TTL = grace window) in Android Keystore/StrongBox.
- Returning users work offline while the token is valid; new/expired logins need a
  panel node.
- Revoke early by bumping `tokenVersion` (per user: `logout-all`, `set-password`,
  disable) — or drop a single device cooperatively with `logout-device`.
- Client-side: `checkSession(panelKey, token)` validates offline (signature +
  expiry); `sessionLive(db, payload)` additionally checks the replicated record
  online (account active, tokenVersion match, device still enrolled).
