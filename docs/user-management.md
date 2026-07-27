# User Management

You manage accounts with two tools: the panel's `admin-cli`, or the admin HTTP
API and dashboard. Both tools call the same underlying operations. The panel is
the only service that writes to the signed account database.

See [reference.md](reference.md) for the full list of commands and endpoints.

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

The panel never stores passwords. It stores only an Argon2id verifier and an
OPRF-bound wrapped key. See [security-model.md](security-model.md) for how this
works.

Deleting a user removes the account record from the signed database. This also
removes every sealed grant and device enrollment for that user.

!!! note "Already-issued sessions keep working until they expire"
    A session token is signed and self-contained, so it validates **offline**
    even after you delete the account. Online checks and any new login attempt
    fail immediately. The token itself only stops working when it expires.

## Channel packages (bouquets)

Granting channels one at a time stops scaling somewhere around a few dozen
channels. A **package** is a named bundle — "Basic", "Sports" — that you grant
as one unit:

```bash
admin-cli add-package basic --label "Basic" --members "news-24, kids-tv" --default
admin-cli add-package sports --members "category:Deportes, sports-*"
admin-cli set-user-packages alice basic,sports    # replace alice's package list
admin-cli show-package sports                     # members + the channels they resolve to now
admin-cli remove-package sports                   # grants only it covered are removed
```

!!! note "The CLI package commands need direct store access"
    Run them with the panel stopped. To change packages while the panel is
    running, use the dashboard **Packages** tab or the admin API instead.

A package member can be:

- an explicit stream id,
- an **id glob** (`sports-*` — the same matcher publisher scopes use), or
- a selector: `category:<slug>` (a parent slug also covers its `Parent/Child`
  rails) or `source:<name>` (every channel imported by that remote source).

Selectors resolve against the catalog **at reconcile time**. This means a
channel that is newly tagged, imported, or created joins the package by itself.
An explicit id can also name a channel that doesn't exist yet — it joins the
package as soon as that channel is added.

A grant is a **sealed key**, not an access-control entry, so the panel cannot
check package membership at request time. Instead, every package change
**materializes immediately** into per-user sealed grants: assigning a package,
editing its members, removing it, adding or retagging or deleting a stream,
syncing a source, and even a panel boot all trigger this reconcile step. A
client sees its new keys at its next login — the same as a manual grant. No
client, SDK, or wire change is involved.

Each grant carries **provenance**: `manualGrants` (granted one by one) or
`packages` (assigned as part of a bundle). The dashboard Users tab shows
package chips, manual chips, and source auto-grant chips separately, so you can
tell where each grant came from. The rules:

- **Revoking a single stream removes the manual grant only.** If one of the
  user's packages still covers that stream, the panel re-seals the grant in
  the same request. Access then comes from the package alone — the CLI
  reports this instead of claiming a plain revoke.
- **Removing a package (or one of its members) removes only what nothing else
  covers.** Manual grants, other packages, and auto-grant source channels
  always survive.
- **A `default` package is assigned to every newly created user**, alongside
  the existing source auto-grant hook (which keeps working unchanged).
  Flipping `default` later never touches users who already exist.
- **A source with auto-grant off can still be package-governed** — add it as a
  `source:<name>` member. Only package holders get its channels, and they
  follow the source as its channel list changes. Turning a source's
  auto-grant off moves any channels it previously auto-granted away from
  users on the next reconcile, unless a package or manual grant still covers
  them.
- Revocation stays **cooperative**: removing a sealed key stops future logins
  from recovering it, but a client that already unsealed the key needs a
  stream-key rotation for a hard lockout. This is the same caveat as any
  revoke.

Upgrading a pre-package deployment migrates automatically at the panel's first
boot afterward: every existing grant becomes a *manual* grant, except channels
owned by an auto-grant source, which stay attributed to that source. Nothing a
user already had is revoked by the upgrade.

## Devices

```bash
admin-cli set-max-devices alice 2     # concurrent device limit
admin-cli list-devices alice          # enrolled devices (id, label, issued/expiry)
admin-cli logout-device alice <deviceId>   # drop ONE enrollment (see below)
admin-cli logout-all alice            # bump tokenVersion -> forces re-login everywhere
```

The panel enforces device limits at login, by serializing the count check and
the add together. If you log a device out, a copy of that device with a still
valid cached session keeps working until its next contact with the panel, or
until the session expires — whichever comes first.

!!! warning "Per-device logout is session hygiene, not content protection"
    Logging out one device removes its enrollment **without** bumping
    `tokenVersion`, so the user's other devices stay signed in. The SDK's
    online check (`sessionLive`) sees the device is gone from the replicated
    record and returns that client to the login screen — but a hostile client
    keeps its cached token and any stream keys it already unsealed. To
    actually revoke access, revoke the grant(s) and rotate the stream key.

## Sessions

- On a successful online login, the client seals its stream keys and a
  panel-signed session token — valid for the grace window — into Android
  Keystore/StrongBox.
- A returning user works offline while the token is still valid. A new or
  expired login needs to reach a panel node.
- To revoke a session early, bump `tokenVersion` for that user
  (`logout-all`, `set-password`, or `set-status disabled`), or drop a single
  device cooperatively with `logout-device`.
- On the client: `checkSession(panelKey, token)` validates the token offline
  (checks the signature and the expiry). `sessionLive(db, payload)` also
  checks the replicated record online — that the account is active, the
  `tokenVersion` matches, and the device is still enrolled.
