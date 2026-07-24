# Security Policy

Aliran handles authentication, encryption, and entitlements. Security is a
first-class concern — see [`docs/security-model.md`](docs/security-model.md) for the
full threat model and honest limitations.

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Instead, report privately via GitHub Security Advisories ("Report a vulnerability"
under the repository's *Security* tab).

Please include: affected component (panel / broadcaster / client), version/commit,
reproduction steps, and impact. We aim to acknowledge within 72 hours.

## Scope highlights

- **Do** report: auth bypass, key/secret leakage, OPRF/brute-force weaknesses,
  session/device-limit bypass, entitlement bypass, remote code execution.
- **Out of scope / known by design:** you cannot prevent peers from *connecting* to a
  public swarm topic (content confidentiality is enforced by encryption, not by
  blocking connections); an entitled user can always capture what they are entitled
  to decrypt (there is no DRM, deliberately). These are documented in the security
  model.

## For operators

Security rests entirely on **per-deployment secrets** (panel signing key, OPRF key,
user passwords), never on code obscurity. Protect and back up your keys, tune Argon2id
appropriately, and consider an independent review of any changes to the crypto paths.
