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
