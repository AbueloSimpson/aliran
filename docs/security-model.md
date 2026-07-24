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
  protection, isLive, poster, backdrop, logo, feedKey, blobsKey, status }`
  (`protection` is a reserved field that always reads `'self'` in current builds)
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

## No DRM, no geo-locking — deliberately

Aliran does **not** implement DRM or geo-restriction, and neither is planned. The
content-protection model is honest access control: feeds are encrypted end to end,
each user's stream keys are sealed individually at grant time, sessions are
cooperative, and the real revocation boundary is **stream-key rotation** (rotate the
channel's encryption key and old keys stop decrypting new segments for everyone).
That protects against non-entitled parties; it does not — and does not claim to —
stop an *entitled* viewer from capturing what they can lawfully decrypt. Commercial
DRM makes the same admission behind more machinery. Operators whose licensing
demands hardware-enforced DRM or territorial enforcement should recognize that this
platform is the wrong tool for that content.

## What this does NOT protect against

- Blocking peers from *connecting* to a public swarm topic (confidentiality is via
  encryption, not connection-gating).
- Offline brute-force **if** you enable a fully-offline login fallback (we did not).
- An entitled user retaining decrypted content (no DRM, see above).
- Panel OPRF-key compromise (re-enables offline attack) — protect and back it up.

## Implementation audit (hardening pass)

A wire-compatible implementation audit of the shipped crypto/auth paths (no protocol
change, no redesign — deployed players/SDKs/apps are unaffected). This section is the
standing record of what was checked, the parameter verdicts, and the residual risks —
it doubles as the package for any future external review.

### Parameters (verdicts)

All values are deployment-tunable via env; the audit confirmed the **defaults** are
sound and left them unchanged. Argon2id memory is well above the OWASP 2024 floor
(19 MiB, t=2) and in RFC 9106 territory.

| Parameter | Default | Verdict |
| --- | --- | --- |
| Argon2id — panel login | 256 MiB, t=3 | Strong. Runs in a worker thread, single-flight, so cost cannot stall the loop. |
| Argon2id — control/reseller admins | 64 MiB, t=2 | Adequate for interactive admin login (≥ OWASP floor); same worker/single-flight protection. |
| `POW_DIFFICULTY` | 16 leading zero bits | Reasonable admission control; per-attempt, connection-bound (below). |
| `SESSION_TTL_DAYS` | 30 | Intentional (returning users work offline); revocation is online via `tokenVersion`. |
| admin/control session TTL | 12 h | Appropriate for a privileged HTTP session. |
| `LOCKOUT_THRESHOLD` / `LOCKOUT_SECONDS` | 10 / 900 s | Reasonable fixed window; the counter map is now bounded (below). |

### Surfaces audited

- **Timing safety.** Every comparison on secret-derived material is constant-time:
  password verifiers via `sodium_memcmp` (`core/password.js`), session/register
  signatures via libsodium `crypto_sign_verify_detached`, the reseller top-up webhook
  via `crypto.timingSafeEqual` with a length pre-check. No `===`/`!==` on secret hex.
- **Malformed-input safety (fixed).** Every attacker-controlled hex field on the login
  RPC (`panel/src/rpc.js`) now decodes through a strict `hexField()` guard: a
  non-string, bad-hex, or wrong-length value fails closed with a JSON error. Before the
  fix, a non-string field made `b4a.from(x,'hex')` throw a `TypeError`, which
  protomux-rpc funnels to `safety-catch` — and `safety-catch` **rethrows** TypeErrors
  into a microtask, crashing the process. `login {"powNonce":{}}` was an unauthenticated
  remote panel kill. Regression: `npm run test:rpc-hardening`.
- **Replay.** The `register` and login flows bind their Ed25519/PoW proof to a
  **per-connection random challenge that rotates one-shot** per use. A captured,
  validly-signed `register` cannot be replayed on a fresh connection (fresh challenge)
  or re-submitted on the same one (rotated) — so a channel's `feedKey` cannot be rolled
  back by replay. The PoW challenge is likewise connection-bound and single-use. The
  reseller webhook adds a ±300 s timestamp window + event-id idempotency. Regression:
  `test:rpc-hardening` part B, `test:reseller`.
- **Revocation.** `tokenValid` checks signature **and** expiry everywhere a token is
  accepted; every authenticated HTTP route then re-checks the **live** record —
  `adminTokenLive` (panel/broadcaster/library) and `principalTokenLive` (reseller)
  confirm the account still exists, is active, and the token's `tokenVersion` matches.
  A `tokenVersion` bump (password rotate, disable, logout-all) invalidates live sessions
  on their next online check. User session tokens carry `role`-less payloads and are
  rejected by the admin gate (`role !== 'admin'`), so a viewer token cannot reach an
  admin route.
- **Resource exhaustion.** The fixed-window throttle map is now **bounded** (expired-
  window sweep + oldest-eviction past a cap) in all four copies, so a flood of junk
  usernames/peers cannot exhaust memory. JSON bodies are capped (1 MiB; 10 MiB for art)
  and enforced by destroy-on-exceed; `/healthz` and `/metrics` answer from cheap
  synchronous sources only; admin login verifies single-flight in a worker (503 on
  overlap) so a login flood cannot stall the event loop or replication.
- **Key hygiene.** No secret is logged: the S40 config-validation echoes cover only
  non-secret ints/bools, hex key env vars print length-only, and error messages carry no
  key material. Key and credential **files** are `0600`; their **directories**
  (`keys/`, `secrets/`) are now created `0700`.

### Residual risks (accepted — wire-compatible constraints)

These are inherent to the shipped protocol and would require a breaking change (new
player/SDK/app builds) to remove, which is explicitly out of scope. They are documented
rather than implemented:

1. **Bearer session tokens are replayable across devices.** The token embeds a
   `deviceId` but is not cryptographically bound to the device; anyone holding a valid,
   unexpired token can present it. This is the deliberate *cooperative-sessions* model —
   the real revocation boundary for live content is grant-revoke + **stream-key
   rotation**, not the token. Hardware device-binding (Android Keystore attestation in
   the proof) would be a protocol change.
2. **Offline token validity until expiry.** Signed tokens are offline-checkable by
   design, so for a client that is offline, revocation (`tokenVersion` bump) only bites
   on its next online check — worst-case latency is the session TTL. Accepted trade for
   offline playback.
3. **Legacy shared publisher key.** With `LEGACY_PUBLISHER=1` (the default, for
   single-broadcaster deployments) unnamed registers verify against the shared init key
   at implicit scope `*`. The panel now **warns at boot** when this is on while named
   publishers are enrolled; set `LEGACY_PUBLISHER=0` to close it once every broadcaster
   carries `PUBLISHER_NAME`.
4. **In-memory key material is not zeroed.** sodium key buffers live on the JS/GC heap;
   best-effort wiping is unreliable in a managed runtime and is not attempted. Protect
   the host; the OPRF/signing keys on disk are the crown jewels (`0600`, backed up
   encrypted).
5. **The panel catalog swarm has no connection cap.** Every client replicates the signed
   catalog over one swarm, so it is intentionally open; confidentiality is via
   encryption, not connection-gating (see above).
6. **OPRF construction is not independently certified.** The 2HashDH login follows
   RFC 9497 over the audited `@noble/curves` ristretto255, but the construction itself
   has not had a certified third-party review.
7. **`PANEL_ADMIN_URL` should not embed credentials.** Supply the reseller/library
   service credentials via `PANEL_ADMIN_USER`/`PANEL_ADMIN_PASS`, never as URL userinfo
   — the URL is surfaced in diagnostics and would carry embedded credentials with it.

### Dependencies

The shipped crypto path carries no known advisories (`sodium-native` 4.3.3 / 5.1.0,
`hypercore-crypto` 3.7.0, `protomux-rpc` 1.10.0, `@noble/curves` 1.9.7,
`@noble/hashes` 1.8.0, `b4a` 1.8.1, `safety-catch` 1.0.3). `npm audit` reports one
high-severity advisory against **electron** (the optional desktop player's build-time
dependency, renderer-process CVEs) — not a shipped crypto path; its fix is a breaking
major bump and is tracked separately from this pass.
