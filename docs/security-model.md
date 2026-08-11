# Security Model

This is the flagship document. Read it before deploying. Aliran's security rests
**only on per-deployment secrets** (panel signing key, OPRF key, user passwords).
It never rests on code obscurity.

## Assets & authorities

- **Panel signing keypair** — signs the account/catalog Hyperbee. Its public key is
  pinned/configured in the client. Every record is verifiable and tamper-evident.
- **OPRF secret key** — the brute-force choke point (see below). Critical asset.
- **Per-stream content encryption key** — confidentiality of the feed.
- **Publisher keys** — authorize broadcasters to write catalog records over the
  register RPC. Per-site enrolled keys carry channel scopes (below); the panel
  stores only their public halves.
- **User passwords** — never stored; only Argon2id verifiers + OPRF-bound wrap keys.

## Account database

A **single-writer, panel-signed Hyperbee**. Clients replicate it read-only and pin
the panel public key, so records are provably authentic. Namespaces:

- `catalog/<streamId>` → OTT metadata `{ title, description, category[], type,
  protection, isLive, poster, backdrop, logo, feedKey, blobsKey, status }`
  (`protection` is a reserved field that always reads `'self'` in current builds).
  **Note:** the stream's content encryption key is **not** in the catalog. It is
  held in a panel-private, non-replicated secrets file and delivered per-user
  (below). `blobsKey` (the feed drive's blobs-core key, published by the panel for
  keyless repeater nodes) is deliberately public: knowing it lets a peer
  **replicate the encrypted video blocks**, nothing more. Every block is ciphertext
  under the stream key, which still only travels sealed per-user through a grant.
- `user/<username>` → `{ salt, verifier, argon, pub, encPriv,
  wrapped:{ [streamId]: sealedStreamKey }, manualGrants[], packages[],
  devices[], tokenVersion, maxDevices, status }`.
  `manualGrants`/`packages` record **why** each grant exists — granted by
  hand, or granted through a channel package. They are plain provenance metadata,
  not secrets, and nothing outside the panel reads them. `wrapped` stays the wire
  format clients unseal at login. A **package cannot be a runtime check**, because
  a grant is a sealed key, so the panel's reconcile engine
  (`panel/src/packages.js`) *materializes* package changes into `wrapped`. The
  package registry itself is a plain panel-local file (`DATA_DIR/packages.json` —
  names and member selectors only, nothing secret). Revocation semantics are
  unchanged: removing a package deletes sealed keys from the record, and a client
  that already unsealed a key is only locked out by a stream-key rotation.

## Login without reading secrets

- Passwords are **never stored**. Login runs an OPRF with the panel to produce
  `rwd` (see below). The record stores only `verifier = Argon2id(rwd, salt)`
  (`sodium-native crypto_pwhash`), which confirms a correct password but reveals
  nothing.
- Each user has an **X25519 keypair**. The public key `pub` is stored in the clear.
  The private key is stored **sealed** (`encPriv`) under a key derived from `rwd`,
  so only the correct password can recover it.
- A stream is **granted** by sealing its content key to the user's `pub`
  (`crypto_box_seal` → `wrapped[streamId]`). This needs no password, so grants can
  be added any time after enrollment. Only the user — after logging in and
  recovering their private key — can open it.
- So clients can **view** the replicated DB to validate it, but see only
  ciphertext for every secret. They cannot read protected data in clear.

## Brute-force protections (layered)

1. **OPRF-bound key derivation (kills offline attack).** Login runs an Oblivious
   PRF with the panel: the client blinds the password, the panel evaluates it with
   its secret OPRF key and returns the result, and the client unblinds it into
   `rwd`. From `rwd` the client derives the `verifier` (`Argon2id`, memory-hard)
   and the key that unseals its private key. Without the panel's OPRF key, an
   attacker with a DB copy **cannot compute `rwd`**, and so cannot test guesses
   offline.
2. **Panel-side throttling + lockout** per username and per peer key (exponential
   backoff, temporary lockout). This is enforceable because #1 funnels guesses
   through the panel.
3. **Proof-of-work** admission on each login attempt.
4. **Memory-hard Argon2id** tuned to target hardware.
5. **High-entropy credentials + policy**, unique salts.
6. **Blast-radius containment:** per-user wrapped keys, stream-key rotation, device
   binding via Android Keystore/StrongBox.

## Sessions, expiry, device limits

- Panel-signed session token `{ userId, deviceId, issuedAt, expiresAt, tokenVersion }`.
- **Absolute TTL** (offline-checkable) + **version/epoch revocation** (online).
- **Decided policy:** returning users keep working offline via cached sessions.
  **New or expired logins require a panel node.** The configured TTL is long by
  design.
- **maxDevices** is enforced at the panel — the single writer serializes the count
  check and the add together. Eviction bumps a device's `tokenVersion`. Enforcement
  latency equals the session TTL.

## Broadcaster registration: per-publisher keys & channel scopes

Anyone on the DHT can reach the `register` RPC. An Ed25519 signature over
`hash(challenge || payload)` is what authorizes a catalog write. Two identity
models exist:

- **Enrolled publishers (recommended for more than one broadcaster).** You enroll
  each broadcaster site with `add-publisher <name> --scopes …`. The panel mints
  the site an **own keypair** (the secret is shown once, and goes in that site's
  `PUBLISHER_KEY` + `PUBLISHER_NAME`) and records only the public key plus
  admin-assigned **channel scopes** (streamId globs, for example `east-*`) in the
  panel-private `DATA_DIR/secrets/publishers.json` (0600, never replicated — the
  same handling as admin credentials). A named register is verified against
  **that site's** key, and its `streamId` is scope-checked **before any write** —
  the same gate covers the catalog record, the private stream-secret store, and
  `isLive`, because one responder writes all three. Accepted writes are stamped
  `origin:<name>` in the (public) catalog record and the activity feed, giving
  real attribution per site. **Containment:** a key stolen from one downlink site
  can only touch that site's channel ids. It cannot re-point, black out, or
  rewrite the rest of the lineup — the classic broadcast-intrusion move.
  **Revocation** is a per-site status flip (`revoked`) — there is no need to
  re-key every other site — and scope edits apply from the site's next register
  (the registry file is re-read each time). Safe failover follows from scoping:
  re-scope a dead site's channels to the standby box, and when the dead box comes
  back, its stale re-asserts bounce with `out-of-scope` instead of fighting the
  standby for the feedKey.
- **Legacy shared key.** `init` also mints one shared publisher keypair.
  Payloads without a `publisher` name verify against it at implicit scope `*`.
  This is fine for a single-broadcaster deployment. With several sites, it is a
  shared secret with none of the properties above — any holder can rewrite any
  channel, unattributed, and revocation means re-keying everyone. Set
  `LEGACY_PUBLISHER=0` on the panel once every site is enrolled, to close this
  path.

**What scoping does NOT give you:** content integrity. A rogue operator at a site
that *legitimately* carries a channel can still feed bad content into its own
encoder input. Scopes give containment, attribution, and one-click revocation —
not a review of the pixels. Multi-writer (Autobase) catalogs remain the roadmap
answer for multi-admin trust.

## Discovery, firewall, IP

- The panel is found by **public key over the DHT** — no IP or DNS needed. It runs
  behind a firewall or NAT with no inbound ports (hole-punching). The optional
  `relayOnly` setting hides the origin IP.
- A directly connected peer can observe the panel's public IP. This is not
  anonymous unless you add a relay or VPN.

## The service pairing code

A viewer can reach a panel with a 12-character **pairing code** (`A3K7-9QF2-M4XR`)
instead of the 64-character panel public key. See
[the operator guide](operator-guide.md#the-service-pairing-code).

The panel calculates the code from its own public key with **Argon2id**, then keeps
the first 60 bits and writes them in Crockford base32. Thus:

- No registry exists. The panel creates nothing and stores nothing.
- The code holds **no password**. It is not a secret.
- The panel announces on a DHT topic that comes from the code.

**How the app verifies the service.** The topic is public, so any peer can answer
on it. The app therefore trusts no answer. It calculates the code again from the
panel key in the answer. If that code does not equal the code the viewer typed, the
app refuses the answer and continues to look. After a match, the app opens the
panel database **by key**, exactly as a typed key does. The panel key stays the
root of trust.

**The attack this prices out.** An attacker wants a keypair whose code is the same
as a true operator's code. A viewer would then pair with the attacker panel and
type a true username and password into it. The attacker holds that panel's OPRF
key, so the attacker can attack the password offline afterwards.

Two properties make this expensive:

- **60 bits.** The attacker must search approximately 2^60 keypairs.
- **A memory-hard step.** Each candidate costs one Argon2id evaluation at
  interactive limits (approximately 70 ms and 64 MiB on a desktop CPU). Memory
  hardness limits how much a GPU or an ASIC helps.

The length is 12 characters, not 8, to keep this margin. The purpose is **not** to
hide the panel key: the panel key is public, and every viewer replicates the
catalog by it.

**What the code does not do.** It gives no entitlement. A viewer who pairs still
signs in with a username and a password, and still receives only the channels the
operator granted.

## No DRM, no geo-locking — deliberately

Aliran does **not** implement DRM or geo-restriction, and neither is planned. The
content-protection model is honest access control: feeds are encrypted end to end,
each user's stream keys are sealed individually at grant time, and sessions are
cooperative. The real revocation boundary is **stream-key rotation** — rotating
the channel's encryption key stops old keys from decrypting new segments for
everyone. That protects against non-entitled parties. It does not — and does not
claim to — stop an *entitled* viewer from capturing what they can lawfully
decrypt. Commercial DRM makes the same admission behind more machinery. Operators
whose licensing demands hardware-enforced DRM or territorial enforcement should
recognize that this platform is the wrong tool for that content.

## Account keys at rest (televisions)

A television signed in by a phone ("send to TV") never receives a password — what
crosses is the account's two private keys, and the device has to hold something to
sign itself back in after Android reclaims its process. It holds this:

| On the device | What it is |
| --- | --- |
| `box` | the account record (username, operator key, X25519 secret, Ed25519 secret) sealed with libsodium secretbox under a random 32-byte **file key**, in the app-private prefs file |
| `key` | that file key, wrapped by an AES-256-GCM key held in the **Android Keystore** under alias `aliran.signin.v1` |

The Keystore key is generated in the key store and never leaves it. On any device
with a hardware keymaster it lives in the TEE, so the app can ask the OS to
unwrap but cannot read the key itself — and neither can anything that reads the
app's files. `secureKeyStatus()` reports whether that is true on a given device
rather than assuming it — and it reports rather than finds out: it will not create
a key in order to describe one, so a device that has never kept a sign-in answers
`keyPresent: false` with an *unknown* security level instead of a claim.

**What this buys, plainly.** Reading the app's private files is no longer enough:
the box is inert without the Keystore, and the Keystore only answers this app on
this device. Copying the files to another device gets nothing. Compare the saved
password of an ordinary sign-in, which is **plaintext at rest** in the same file —
this is the first credential in the app that is not.

**What it does not buy.** The key is bound to the *app*, not to a person. There is
deliberately no `setUserAuthenticationRequired`: a television usually has no secure
lock screen, so requiring one would mean the key could not be created at all on the
devices this feature exists for, and where it could, the set could not sign itself in
until somebody walked over with a remote — the exact problem the feature removes. So
**anyone who can run code as the app can ask the Keystore to unwrap.** On a rooted
device, or one with a compromised OS, that is a straightforward extraction; the
Keystore raises the bar from "read a file" to "execute as this app", and no further.
An operator who treats set-top boxes in uncontrolled locations as trusted should not
change that judgement because of this section.

**"The account keys never leave the worklet" is not a sandbox.** It is said often in
the code and it is worth being exact about, because it sounds like an isolation
boundary and is not one: the Bare worklet is a *thread inside the app's own process*,
with the same UID, the same files and the same debugger. What the arrangement actually
guarantees is narrower and still worth the forty lines it costs — the account's two
private keys are only ever in that runtime's heap, so they **never enter the React
Native message stream**, and therefore never the debug logger that prints it, never a
host listener, never a component's state, never a problem report. The only secret that
crosses is the random file key, which opens nothing without a file the other side never
sees. Against code running *as the app*, none of this helps; see the paragraph above.

Nor is any of it erasable from memory afterwards. The file key and both account keys
are immutable JavaScript strings, copied by every hop that touches them, and nothing in
either runtime can overwrite one. They sit in the heap until a garbage collector that
makes no promises gets to them — in practice, for the life of the process.

**How an operator actually evicts such a device.** The last column says whether the
row is asserted against a real panel by `test:signin-resume` or reasoned from
behaviour tested elsewhere.

| Action | Effect on a kept sign-in | |
| --- | --- | --- |
| Change the viewer's password | **Evicts.** `set-password` mints a *fresh* account keypair and re-seals the grants to it, so the stored keys stop matching the record and the device erases them. | asserted |
| Disable the account | **Evicts.** The panel refuses the session; the device erases. | asserted |
| Rotate the channel's stream key | **Evicts from that channel**, as for every other device. | reasoned |
| "Log out all devices" (`tokenVersion`) | **Does not evict.** It ends live sessions; a device still holding working keys takes a new token on its next start. | asserted |
| Revoke the one device | **Does not evict.** It drops the enrolment; the device re-enrols. | reasoned |
| Fill the account's device slots, on a panel configured `devicePolicy: reject` | **Does not evict.** The panel answers `device-limit`, which says the slots are full — not that these keys are dead. The set keeps them and signs itself in the moment a slot frees. | asserted |

The middle three are not new behaviour and not specific to televisions — a device
holding a saved *password* signs straight back in after all of them, and always has.
They are listed because storing keys makes it worth saying out loud which lever is
the real one: **change the password.**

**`device-limit`, and why it keeps.** It is the one refusal on that list that reads
like a verdict and is not, and treating it as one was a defect. Slots free
themselves: an enrolment expires (30 days) or a viewer signs another device out, and
the identical stored keys work again. Erasing gains the viewer nothing — they must
then redo a handover *and* still meet the same limit — while keeping costs one
refused login per boot until a slot opens. It belongs with `sessions unavailable`:
a fact about the operator's configuration, not a judgement on an account.

Two qualifications, and they cut opposite ways. It is **unreachable on a default
deployment**: `devicePolicy` defaults to `evict` and nothing the panel ships passes
`reject`, so the limit drops the oldest device rather than refusing the new one. And
it is the only refusal here that **another device can cause** — on an operator who
does set `reject`, a television whose own enrolment lapsed while it was switched off
comes back as a new device and finds the household's other sets holding every slot.
Under the old classification, somebody else's phone silently destroyed the
television's sign-in.

**What does NOT erase it**, and deliberately so. Erasing is the only irreversible act
in this feature, and its cost to a viewer is walking to another room for a phone — so a
device erases only on positive evidence that the material can never work again (the key
store saying these bytes will not open, a box that fails its MAC, an operator this
device has left, or a verdict from the panel above). A key store that did not answer, a
swarm still dialling, an account record that has not replicated to this device yet: all
of those **keep** what is held and try again on the next start.

**A deleted account is the honest cost of that default**, and it is worth an operator
knowing exactly what it leaves behind. Deleting the account leaves an inert record on
the television's disk, because "this device's copy of the signed record has no such
account" is what a cold start looks like as well. Three consequences follow:

- The set **spends a small login budget on every boot** trying it — see below. It
  never locks the account out, and it never stops trying either.
- The record **cannot be revived by re-creating the username.** Creating an account
  again mints a fresh keypair, so the stored key fails the seal probe
  (`key handover does not match this account`) and *that* does erase. Re-creating a
  deleted viewer therefore evicts the television rather than restoring it.
- The set falls through to its sign-in screen every time, which is what a viewer
  sees. Nothing on the television says the account is gone.

The lever that cleans it up on the device is the same one as always: **change the
password** before deleting, or let the viewer sign the set out.

**What a boot may spend at the panel.** Keeping means retrying, and a retry that
reaches the panel costs a `login` — which `LOCKOUT_THRESHOLD` counts whether it
succeeded or not, per account *and* per device. So the restore door is budgeted in
logins, not in seconds: **an attempt that reached the panel ends it for that boot**,
and attempts that never left the device (no socket yet, a key store that did not
answer) are bounded by a wall-clock deadline instead. A boot therefore spends at most
what one resume can spend — three logins today — so several restarts inside one
lockout window still fit under a threshold of ten, and a television can never lock out
the password screen a viewer standing in front of it needs.

**Sign out erases it**, and erases both halves — the record in the worklet and the
Keystore key it was sealed under, so the file cannot be read even if it survives.
Changing the operator ("Change service…") erases it too: the record names the panel it
came from and is worthless anywhere else. Uninstalling the app, "clear data" and a
factory reset destroy the Keystore key too.

Only builds that ask for this hold anything: the engine hands the material over
solely when constructed with `remote: { keepSignIn: true }` — **by name**, since the
`remote: true` shorthand covers the two features that are about memory and pointedly
not this one — and the viewer app sets it on televisions and nowhere else. A phone
signed in by another phone still has a keyboard and a password, so it keeps nothing.

## What this does NOT protect against

- Blocking peers from *connecting* to a public swarm topic (confidentiality comes
  from encryption, not from connection-gating).
- Extraction of a television's stored sign-in by code running **as the app** on a
  rooted or compromised device (see "Account keys at rest" — the Keystore binds the
  key to the app, not to a person).
- Offline brute-force **if** you enable a fully-offline login fallback (we did
  not).
- An entitled user retaining decrypted content (no DRM, see above).
- Panel OPRF-key compromise (this re-enables offline attack) — protect and back it
  up.

## Implementation audit (hardening pass)

This section records a wire-compatible implementation audit of the shipped
crypto/auth paths: no protocol change, no redesign, and deployed players, SDKs,
and apps are unaffected. It is the standing record of what was checked, the
parameter verdicts, and the residual risks — it doubles as the package for any
future external review.

### Parameters (verdicts)

All values are deployment-tunable via env; the audit confirmed the **defaults**
are sound and left them unchanged. Argon2id memory is well above the OWASP 2024
floor (19 MiB, t=2) and in RFC 9106 territory.

| Parameter | Default | Verdict |
| --- | --- | --- |
| Argon2id — panel login | 256 MiB, t=3 | Strong. Runs in a worker thread, single-flight, so cost cannot stall the loop. |
| Argon2id — control/reseller admins | 64 MiB, t=2 | Adequate for interactive admin login (≥ OWASP floor); same worker/single-flight protection. |
| `POW_DIFFICULTY` | 16 leading zero bits | Reasonable admission control; per-attempt, connection-bound (below). |
| `SESSION_TTL_DAYS` | 30 | Intentional (returning users work offline); revocation is online via `tokenVersion`. |
| admin/control session TTL | 12 h | Appropriate for a privileged HTTP session. |
| `LOCKOUT_THRESHOLD` / `LOCKOUT_SECONDS` | 10 / 900 s | Reasonable fixed window; the counter map is now bounded (below). |

### Surfaces audited

- **Timing safety.** Every comparison on secret-derived material is
  constant-time: password verifiers via `sodium_memcmp` (`core/password.js`),
  session/register signatures via libsodium `crypto_sign_verify_detached`, and
  the reseller top-up webhook via `crypto.timingSafeEqual` with a length
  pre-check. No comparison uses `===`/`!==` on secret hex.
- **Malformed-input safety (fixed).** Every attacker-controlled hex field on the
  login RPC (`panel/src/rpc.js`) now decodes through a strict `hexField()` guard:
  a non-string, bad-hex, or wrong-length value fails closed with a JSON error.
  Before the fix, a non-string field made `b4a.from(x,'hex')` throw a
  `TypeError`. protomux-rpc funnels that to `safety-catch`, and `safety-catch`
  **rethrows** TypeErrors into a microtask, crashing the process. That meant
  `login {"powNonce":{}}` was an unauthenticated remote panel kill. Regression
  test: `npm run test:rpc-hardening`.
- **Replay.** The `register` and login flows bind their Ed25519/PoW proof to a
  **per-connection random challenge that rotates one-shot** per use. A captured,
  validly-signed `register` cannot be replayed on a fresh connection (the
  challenge is fresh) or re-submitted on the same one (the challenge has
  rotated) — so a channel's `feedKey` cannot be rolled back by replay. The PoW
  challenge is likewise connection-bound and single-use. The reseller webhook
  adds a ±300 s timestamp window plus event-id idempotency. Regression tests:
  `test:rpc-hardening` part B, `test:reseller`.
- **Revocation.** `tokenValid` checks signature **and** expiry everywhere a token
  is accepted. Every authenticated HTTP route then re-checks the **live**
  record: `adminTokenLive` (panel/broadcaster/library) and `principalTokenLive`
  (reseller) confirm the account still exists, is active, and the token's
  `tokenVersion` matches. A `tokenVersion` bump (password rotate, disable,
  logout-all) invalidates live sessions on their next online check. User session
  tokens carry `role`-less payloads and are rejected by the admin gate
  (`role !== 'admin'`), so a viewer token cannot reach an admin route.
- **Resource exhaustion.** The fixed-window throttle map is now **bounded**
  (expired-window sweep + oldest-eviction past a cap) in all four copies, so a
  flood of junk usernames or peers cannot exhaust memory. JSON bodies are capped
  (1 MiB; 10 MiB for art) and enforced by destroy-on-exceed. `/healthz` and
  `/metrics` answer from cheap synchronous sources only. Admin login verifies
  single-flight in a worker (503 on overlap), so a login flood cannot stall the
  event loop or replication.
- **Key hygiene.** No secret is logged: the config-validation echoes cover
  only non-secret ints and bools, hex key env vars print length-only, and error
  messages carry no key material. Key and credential **files** are `0600`; their
  **directories** (`keys/`, `secrets/`) are now created `0700`.

### Residual risks (accepted — wire-compatible constraints)

These are inherent to the shipped protocol. Removing them would need a breaking
change (new player/SDK/app builds), which is explicitly out of scope. They are
documented rather than implemented:

1. **Bearer session tokens are replayable across devices.** The token embeds a
   `deviceId` but is not cryptographically bound to the device — anyone holding a
   valid, unexpired token can present it. This is the deliberate
   *cooperative-sessions* model: the real revocation boundary for live content is
   grant-revoke plus **stream-key rotation**, not the token. Hardware
   device-binding (Android Keystore attestation in the proof) would be a
   protocol change.
2. **Offline token validity until expiry.** Signed tokens are offline-checkable
   by design, so for an offline client, revocation (a `tokenVersion` bump) only
   bites on its next online check — the worst-case latency is the session TTL.
   This is an accepted trade for offline playback.
3. **Legacy shared publisher key.** With `LEGACY_PUBLISHER=1` (the default, for
   single-broadcaster deployments), unnamed registers verify against the shared
   init key at implicit scope `*`. The panel now **warns at boot** when this is
   on while named publishers are enrolled. Set `LEGACY_PUBLISHER=0` to close it
   once every broadcaster carries `PUBLISHER_NAME`.
4. **In-memory key material is not zeroed.** sodium key buffers live on the
   JS/GC heap. Best-effort wiping is unreliable in a managed runtime, so it is
   not attempted. Protect the host — the OPRF/signing keys on disk are the
   crown jewels (`0600`, backed up encrypted).
5. **The panel catalog swarm has no connection cap.** Every client replicates
   the signed catalog over one swarm, so it is intentionally open.
   Confidentiality comes from encryption, not connection-gating (see above).
6. **OPRF construction is not independently certified.** The 2HashDH login
   follows RFC 9497 over the audited `@noble/curves` ristretto255, but the
   construction itself has not had a certified third-party review.
7. **`PANEL_ADMIN_URL` should not embed credentials.** Supply the
   reseller/library service credentials via `PANEL_ADMIN_USER`/`PANEL_ADMIN_PASS`,
   never as URL userinfo. The URL is surfaced in diagnostics, and would carry
   embedded credentials with it.
8. **A device that holds a working credential signs itself back in.** "Log out all
   devices" ends live sessions and per-device revocation drops one enrolment;
   neither stops a device that still holds a valid credential from taking a fresh
   token on its next start. This has always been true of the saved password
   ("remember me", plaintext at rest in the app-private prefs file) and is now also
   true of a television's Keystore-wrapped sign-in. The lever that does evict is
   **changing the password**, which re-keys the account. See "Account keys at rest".
9. **Account keys at rest are app-bound, not person-bound.** A television's stored
   sign-in is sealed under an Android Keystore key with no user-authentication
   requirement — a set-top box generally has no secure lock screen, and demanding
   one would defeat the feature. Code running as the app on a rooted or compromised
   device can therefore ask the OS to unwrap it. Accepted: the alternative is a
   television that cannot stay signed in, which is what this replaced.

### Dependencies

The shipped crypto path carries no known advisories (`sodium-native` 4.3.3 / 5.1.0,
`hypercore-crypto` 3.7.0, `protomux-rpc` 1.10.0, `@noble/curves` 1.9.7,
`@noble/hashes` 1.8.0, `b4a` 1.8.1, `safety-catch` 1.0.3). `npm audit` reports one
high-severity advisory against **electron** (the optional desktop player's
build-time dependency, renderer-process CVEs). This is not a shipped crypto path;
its fix is a breaking major bump and is tracked separately from this pass.
