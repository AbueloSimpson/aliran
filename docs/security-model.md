# Security Model

This is the flagship document — read it before deploying. Aliran's security rests
**only on per-deployment secrets** (panel signing key, OPRF key, user passwords),
never on code obscurity.

## Assets & authorities

- **Panel signing keypair** — signs the account/catalog Hyperbee. Its public key is
  pinned/configured in the client. Every record is verifiable and tamper-evident.
- **OPRF secret key** — the brute-force choke point (see below). Critical asset.
- **Per-stream content encryption key** — confidentiality of the feed.
- **Publisher keys** — authorize broadcasters to write catalog records over the
  register RPC. Per-site enrolled keys with channel scopes (below); the panel stores
  only their public halves.
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

## Broadcaster registration: per-publisher keys & channel scopes

The `register` RPC is reachable by anyone on the DHT; an Ed25519 signature over
`hash(challenge || payload)` is what authorizes a catalog write. Two identity models:

- **Enrolled publishers (recommended for more than one broadcaster).** Each
  broadcaster site is enrolled with `add-publisher <name> --scopes …`: the panel
  mints the site an **own keypair** (secret shown once, goes in that site's
  `PUBLISHER_KEY` + `PUBLISHER_NAME`) and records only the public key plus
  admin-assigned **channel scopes** (streamId globs, e.g. `east-*`) in the
  panel-private `DATA_DIR/secrets/publishers.json` (0600, never replicated — same
  handling as admin credentials). A named register is verified against **that
  site's** key and its `streamId` is scope-checked **before any write** — the same
  gate covers the catalog record, the private stream-secret store and `isLive`,
  because one responder writes all three. Accepted writes are stamped
  `origin:<name>` in the (public) catalog record and the activity feed — real
  attribution per site. **Containment:** a key stolen from one downlink site can
  only touch that site's channel ids — it cannot re-point, black out or rewrite the
  rest of the lineup (the classic broadcast-intrusion move). **Revocation** is a
  per-site status flip (`revoked`) — no re-keying of every other site — and scope
  edits apply from the site's next register (the registry file is re-read each
  time). Safe failover falls out of scoping: re-scope a dead site's channels to the
  standby box, and when the dead box comes back its stale re-asserts bounce with
  `out-of-scope` instead of fighting the standby for the feedKey.
- **Legacy shared key.** `init` also mints one shared publisher keypair; payloads
  without a `publisher` name verify against it at implicit scope `*`. Fine for a
  single-broadcaster deployment; with several sites it is a shared secret with
  none of the properties above (any holder can rewrite any channel, unattributed,
  and revocation means re-keying everyone). Set `LEGACY_PUBLISHER=0` on the panel
  once every site is enrolled to close this path.

**What scoping does NOT give you:** content integrity. A rogue operator at a site
that *legitimately* carries a channel can still feed bad content into its own
encoder input — scopes give containment, attribution and one-click revocation, not
a review of the pixels. Multi-writer (Autobase) catalogs remain the roadmap answer
for multi-admin trust.

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
