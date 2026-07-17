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
  protection, allowedRegions?, isLive, poster, backdrop, logo, feedKey, blobsKey,
  drm?, status }`
  — **note:** the stream's content encryption key is **not** in the catalog. It is held
  in a panel-private, non-replicated secrets file and delivered per-user (below).
  `blobsKey` (the feed drive's blobs-core key, published by the panel for keyless
  repeater nodes) is deliberately public: knowing it lets a peer **replicate the
  encrypted video blocks**, nothing more — every block is ciphertext under the
  stream key, which still only travels sealed per-user through a grant.
- `user/<username>` → `{ salt, verifier, argon, pub, encPriv,
  wrapped:{ [streamId]: sealedStreamKey }, devices[], tokenVersion, maxDevices, status }`

## Login without reading secrets

- Passwords are **never stored**. Login runs an OPRF with the panel to produce
  `rwd` (see below); the record stores only `verifier = Argon2id(rwd, salt)`
  (`sodium-native crypto_pwhash`), which confirms a correct password but reveals nothing.
- Each user has an **X25519 keypair**. The public key `pub` is stored in the clear; the
  private key is stored **sealed** (`encPriv`) under a key derived from `rwd`, so only
  the correct password can recover it.
- A stream is **granted** by sealing its content key to the user's `pub`
  (`crypto_box_seal` → `wrapped[streamId]`). This needs no password, so grants can be
  added any time after enrollment. Only the user — after logging in and recovering
  their private key — can open it.
- So clients can **view** the replicated DB to validate, but see only ciphertext for
  every secret; they cannot read protected data in clear.

## Brute-force protections (layered)

1. **OPRF-bound key derivation (kills offline attack).** Login runs an Oblivious PRF
   with the panel: the client blinds the password, the panel evaluates it with its
   secret OPRF key and returns the result, which the client unblinds into `rwd`. From
   `rwd` the client derives the `verifier` (`Argon2id`, memory-hard) and the key that
   unseals its private key. Without the panel's OPRF key, an attacker with a DB copy
   **cannot compute `rwd`** and so cannot test guesses offline.
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
