# Security Model

This is the flagship document — read it before deploying. Aliran's security rests
**only on per-deployment secrets** (panel signing key, OPRF key, user passwords),
never on code obscurity.

## Assets & authorities

- **Panel signing keypair** — signs the account/catalog Hyperbee. Its public key is
  pinned/configured in the client. Every record is verifiable and tamper-evident.
- **OPRF secret key** — the brute-force choke point (see below). Critical asset.
- **Per-stream content encryption key** — confidentiality of the feed.
- **User passwords** — never stored; only Argon2id verifiers + OPRF-bound wrap keys.

## Account database

A **single-writer, panel-signed Hyperbee**. Clients replicate it read-only and pin the
panel public key, so records are provably authentic. Namespaces:

- `catalog/<streamId>` → OTT metadata `{ title, description, category[], type,
  protection, allowedRegions?, isLive, poster, backdrop, logo, feedKey,
  encryptionKey?, drm?, status }`
- `user/<username>` → `{ salt, verifier, wrapped:{ [streamId]: encStreamKey }, status,
  devices[], tokenVersion }`

## Login without reading secrets

- Passwords stored only as **Argon2id verifiers** (`sodium-native crypto_pwhash`).
- Per-user **stream keys are wrapped** under a key derived from the user's password —
  other members replicating the DB see only ciphertext.
- So clients can **view** the DB to validate, but cannot read protected data in clear.

## Brute-force protections (layered)

1. **OPRF-bound key derivation (kills offline attack).** Login runs an Oblivious PRF
   with the panel: the client blinds the password, the panel evaluates with its secret
   OPRF key and returns the result; `wrapKey = Argon2id(rwd, salt)`. Without the panel's
   key an attacker with a DB copy **cannot test guesses offline**.
2. **Panel-side throttling + lockout** per username and per peer key (exponential
   backoff, temporary lockout). Enforceable because #1 funnels guesses through the panel.
3. **Proof-of-work** admission on each login attempt.
4. **Memory-hard Argon2id** tuned to target hardware.
5. **High-entropy credentials + policy**, unique salts.
6. **Blast-radius containment:** per-user wrapped keys, stream-key rotation, device
   binding via Android Keystore/StrongBox.

## Sessions, expiry, device limits

- Panel-signed session token `{ userId, deviceId, issuedAt, expiresAt, tokenVersion }`.
- **Absolute TTL** (offline-checkable) + **version/epoch revocation** (online).
- **Decided policy:** returning users keep working offline via cached sessions;
  **new/expired logins require a panel node**. Long TTL configured.
- **maxDevices** enforced at the panel (single-writer serializes count+add); eviction
  bumps a device's `tokenVersion`. Enforcement latency = session TTL.

## Discovery, firewall, IP

- Panel found by **public key over the DHT** — no IP/DNS. Runs behind firewall/NAT with
  no inbound ports (hole-punching). Optional `relayOnly` hides the origin IP.
- A directly connected peer can observe the panel's public IP; not anonymous unless
  relay/VPN.

## Optional DRM & geo

- **DRM** (BuyDRM/KeyOS, EZDRM, Axinom, …): P2P distribution of CENC bytes + commercial
  license server; panel issues entitlement JWTs. Provides hardware-enforced protection.
- **Geo-locking** enforced at license/entitlement time (panel GeoIP claims and/or vendor
  license geo policy). IP GeoIP is VPN-defeatable (true of all streaming).

## What this does NOT protect against

- Blocking peers from *connecting* to a public swarm topic (confidentiality is via
  encryption, not connection-gating).
- Offline brute-force **if** you enable a fully-offline login fallback (we did not).
- A user retaining self-managed-decrypted content (no hardware DRM unless the DRM
  module is enabled).
- VPN-based geo evasion.
- Panel OPRF-key compromise (re-enables offline attack) — protect and back it up.
