# User Management

All account operations are performed with the panel's `admin-cli` (the panel is the
single writer of the signed account DB).

## Accounts & passwords

```bash
admin-cli create-user alice          # prompts for a password; stores salt + verifier
admin-cli set-password alice          # rotate a password
admin-cli grant alice news            # entitle a user to a stream (wraps the key)
admin-cli revoke alice                # disable an account
admin-cli list                        # list users / streams
```

Passwords are never stored — only an Argon2id verifier + OPRF-bound wrapped keys. See
[security-model.md](security-model.md).

## Devices

```bash
admin-cli set-max-devices alice 2     # concurrent device limit
admin-cli list-devices alice
admin-cli logout-device alice <deviceId>
admin-cli logout-all alice            # bump tokenVersion -> forces re-login everywhere
```

Device limits are enforced at login (the panel serializes count + add). A logged-out
device with a still-valid cached session keeps working until its next panel contact or
until the session TTL expires (enforcement latency = TTL).

## Sessions

- On successful online login the client seals stream keys + a panel-signed session
  token (TTL = grace window) in Android Keystore/StrongBox.
- Returning users work offline while the token is valid; new/expired logins need a
  panel node.
- Revoke early by bumping `tokenVersion` (per user or per device).
