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

## Sending a sign-in from a phone to a television

A television has a remote control, not a keyboard. "Send to TV" lets a phone that
is already signed in put the same account on the set. The television shows a
12-character code, the viewer types that code on the phone, and the two devices
meet on a topic derived from the code. Each side then proves to the other that it
holds the code.

**What crosses.** The phone sends the account **username**, the account's
**X25519 private key**, its **Ed25519 private key**, and the **panel public key**
— inside the Noise connection the two devices already share, which is why nothing
else on the topic can read it. The password does not cross, and the television
never learns it. The television then does a full login of its own: it registers
**its own `deviceId`** and takes **its own panel-signed token**. So `maxDevices`,
the device list, per-device revoke and the activity feed keep working per device,
exactly as for a typed login.

Because the panel key travels with the payload, one action does two jobs: it sets
the service and it signs in. Nobody types 64 hex characters, or the operator's
12-character pairing code, on a remote control.

**Two viewer checks, and each one catches what the other misses.** Both must pass
before the payload leaves the phone.

| Check | What the viewer does | What it catches |
| --- | --- | --- |
| **Compared digits** | Four digits show on **both** screens. The viewer confirms on the **phone** that the television shows the same four. | A **relay** — a peer that holds one connection to each device. Two connections have two different handshake hashes, so the relay's two sets of digits disagree. Each side commits to its half of the digits before it sees the other half, so no side and no relay can choose last. |
| **Entered PIN** | Four digits show on the phone. The viewer types them into the television with the remote. | A **static lure** — a code shown on a screen with no real television behind it. The digits go into a set that is not in the exchange, so the exchange stops. |

A relay that guesses gets **1 chance in 10 000** per completed pairing. The number
is flat: more connections do not improve it, because each side shows exactly one
set of digits. Every failure **spends the code**, and the PIN gets one attempt
with no retry. A second pairing is a new, independent 1 in 10 000, so a viewer who
sees the mismatch warning must stop instead of trying again on the same network.
The warning says so.

**This is not phishing-proof. Do not write it as if it were.** The two checks
remove the static lure and the silent relay. They do not remove an attacker who is
present in real time — a false setup wizard, or a support call that walks the
viewer through both steps — and they do not remove a viewer who taps "yes" without
comparing anything. No protocol round closes that. What the checks change is the
price: a printed code is no longer sufficient, and the attacker must be there at
the moment of pairing.

**Taking an operator key.** A television with no operator key yet is about to take
one from the payload. It asks first: it shows the account name, the operator key,
and that key's printed 12-character pairing code, and it waits for a person to
approve. A television that **already** has an operator key refuses a different one
outright, and does not ask. So on a new set the human check is the whole of this
defence, and on a configured set it is none of it.

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
`keyPresent: false` with an *unknown* security level instead of a claim. **No
shipped screen calls it**, so an operator has no way today to tell a set whose
wrapping key lives in a TEE from a set where it lives in software. The record is
kept either way, deliberately: a key held in software is still better than the
plaintext password beside it.

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
succeeded or not, against the account *and* the peer that asked. So the restore door
is budgeted in logins, not in seconds: **an attempt that reached the panel ends it for
that boot**, and attempts that never left the device (no socket yet, a key store that
did not answer) are bounded by a wall-clock deadline instead. A boot therefore spends
at most what one resume can spend — three logins today, against a threshold of ten —
which leaves room for the set's own password fall-through and for a viewer typing at
the sign-in screen afterwards.

That last part is the reason the budget exists. A device that spends the whole
threshold locks out *itself* (the peer half of the key is the engine's swarm identity,
which is random per app process, so no other device is affected) — and the first thing
it locks out is the sign-in screen it falls through to seconds later, where a viewer
with the correct password is told to wait fifteen minutes.

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

## "Play on my TV" — the account rendezvous

Two devices of one account find each other with no code and no viewer action. The
topic comes from the account's own private key, so only that account's devices can
calculate it. It rolls once a day, and a device joins the current day and the
previous day, which absorbs clock skew. A television announces on it. A phone
looks up and never announces, so a phone publishes no address, and two televisions
never meet.

Membership is proved with a MAC over the connection's handshake hash, keyed from
the account key. Hyperswarm authenticates a peer *keypair*, which says nothing
about who the account holder is — this proof is what authenticates. A device sends
nothing about itself until the other side's proof is verified.

**What a controller can do.** Ask a television to play a channel **that television
is entitled to**, ask it to stop, and read what it shows. The engine checks the
channel against the receiving device's own entitlements, and then deliberately
**does not tune it**: it gives the command to the host app with a `restricted`
flag on it. The host must put a restricted channel through the same parental-PIN
gate a local zap goes through. An engine that tuned on behalf of the peer would
make "play on my TV" the documented way past that gate. Where the engine cannot
read the channel's catalog record, it refuses the command instead of guessing at
the flag.

`setRemoteAccept(false)` makes a television refuse `play` and `stop`. It is the
opt-out inside the protocol, per set.

## Casting to a television on the local network

Ordinary playback serves HLS on `127.0.0.1`. Casting cannot: a television is not
on the phone's loopback interface. So a cast session starts a **second** HTTP
server, and every property of it is narrower than the first:

- It exists **only while a session exists**.
- It binds **one private (RFC1918) address**, not all interfaces. A device whose
  only address is public is **refused**, by name. An address the device has lost
  by the time the server binds is also refused, because the URL would not have
  worked and a wider bind for a dead address is worse than a refusal.
- It serves **only** `/cast/<32-byte token>/…`, from **one pinned feed drive** —
  that channel's playlist, its segments and its live thumbnail. Everything else is
  a 404, including `/assets/*`, `/epg/*` and `/feedthumb/*`.
- The drive is **pinned**, so the television keeps the channel it was given while
  the phone zaps somewhere else.
- The token is new for each session, compared in constant time before any drive
  read, and it is never logged, never emitted and never put in a problem report.

The loopback server of ordinary playback is unchanged, and still refuses
`/cast/*`. One behaviour of it did change with this work: both servers now answer
**405** to methods other than `GET` and `HEAD`. Nothing in the apps sends one.

**Cross-origin reads are on because a measurement showed they are necessary**, not
because they are convenient. The stock receiver page is served from
`https://www.gstatic.com`, so every media fetch it makes is cross-origin. Without
`Access-Control-Allow-Origin`, the measured receiver fetched the playlist and
**zero segments**.

**The receiver application.** The shipped path uses Google's **stock Default Media
Receiver** (`CC1AD845`). An operator needs no Google registration, no fee and no
hosted receiver page. A white-label operator who wants a receiver with their own
branding registers an application id of their own with Google and gives it to the
sender; the bytes this SDK serves do not change.

**The kill switch, for an operator who does not want these features at all.**
Each one is off unless the build asks for it by name: `remote: { sendToTv }` for
the phone half of the sign-in, `remote: { control }` for "play on my TV", and
`remote: { keepSignIn }` for keeping a handed-over sign-in on disk. A build that
asks for none of them joins no rendezvous, holds no account keys and keeps
nothing. Casting is the same kind of decision one level up: the engine starts the
LAN server only when the app calls `startCast()`, and `stopCast()` removes it
immediately.

## Residual risks for send to TV, play on my TV, and casting

Accepted, and written down so an operator can plan around them. Items **8** and
**9** of the register in the hardening pass below also belong to this feature.

Each entry says what is exposed, to whom, for how long, and what an operator can
do about it. Where a claim is proved by a test lane it says **asserted**; where it
follows from the code but no lane drives it, it says **reasoned**; where it comes
from an instrumented run against real equipment it says **measured**.

> ⚠ **None of this has been seen on a television.** The engine work is covered by
> `test:signin-pair`, `test:remote-control`, `test:signin-vault`,
> `test:signin-resume`, `test:remote-core` and `test:cast`, all of which run on a
> desktop against a local panel or a local DHT. The findings below that come from
> real equipment were taken with a laptop and one Google TV set, on firmware that
> set has since replaced. Nothing on a phone screen or a television screen has been
> verified on hardware.

1. **The handover payload is a permanent account credential, not a session.** The
   account's X25519 private key opens **every** sealed stream key in the account's
   signed record, straight out of the replica, with **no panel contact at all**.
   Nothing about that use is visible to the operator: not `maxDevices`, not the
   device list, not the activity feed. Of the operator's levers, *revoke device*
   does not re-key, *log out all devices* does not re-key, and *disable the
   account* does not re-key. **Only a password reset re-keys the account**, because
   it mints a fresh keypair and re-seals the grants to it. Operator guidance after
   any suspected bad handover: **reset the password**. (`test:signin-resume`
   asserts against a real panel that a password change evicts and that "log out all
   devices" does not; that the key opens the sealed records without the panel is
   reasoned from `sdk/login.js`, and per-device revoke from `panel/src/ops.js`)
2. **A television signed in by handover can hand the account onward.** The set
   holds the same key material a phone holds, so it can be the source of the next
   handover. An account can spread transitively from a device as low-trust as a
   shared or hotel television. (reasoned)
3. **The two viewer checks stop a static lure and a silent relay. They do not stop
   a live pretext.** An attacker who is present in real time can walk a viewer
   through the comparison and the entry, and so can a viewer who approves without
   comparing. The relay's own chance is 1 in 10 000 per completed pairing, flat and
   not improved by opening more connections; each new pairing is an independent
   1 in 10 000, so the only bound on repeats is a viewer who heeds the mismatch
   warning. (the mechanism is asserted — `test:signin-pair` runs the relay attack
   and shows there is no set of digits to harvest before a claim, and
   `test:remote-core` pins the commitment binding; the 1 in 10 000 follows from
   four digits, and the live pretext is a design limit, not a measurement)
4. **A new television takes an operator key on a human check alone.** The set
   shows the account, the operator key and that key's printed pairing code, and
   waits for approval. A viewer who approves without reading adopts whatever panel
   the payload named, and that panel then supplies the catalog, the redirect URLs
   and the VOD provider configuration. A television that already has an operator
   key refuses a different one without asking. (asserted, `test:signin-pair`)
5. **Anyone who can read the code off the screen can spend it.** A code-holder can
   claim the exchange and then stall, so the viewer's own phone gets "busy" and
   the code has to be replaced. It is repeatable and silent. It costs a viewer a
   new code and never costs key material. It is inherent to a code shown on a
   screen. (reasoned)
6. **A kept sign-in is erased only on proof, which means a broken television keeps
   trying.** The set destroys what it holds when the key store says the bytes will
   never open, when the sealed record fails its check, when the device has left the
   operator that granted it, or when the panel gives a verdict on the *account*. A
   key store that did not answer, a host that did not answer in time, a swarm still
   dialling, and an account record that has not replicated yet all **keep** what is
   held and try again. Erasing is the one irreversible act here and it costs a
   viewer a walk to another room, so the default runs toward keeping.
   `tools/signin-vault-test.mjs` reads the panel's and the SDK's own error strings
   off the disk, so this classification cannot drift silently when somebody rewords
   a message. (asserted, `test:signin-vault` and `test:signin-resume`)
7. **A deleted account leaves an inert record, and each boot pays a bounded price
   for it.** "This device has no such account" is what a cold start looks like as
   well as what a deletion looks like, so the set keeps its keys and retries. The
   record cannot be revived: creating the username again mints a fresh keypair, the
   stored key then fails, and *that* erases — so re-creating a deleted viewer
   evicts the television instead of restoring it. The retries are budgeted in the
   panel's own units: an attempt that reached the panel ends the restore attempt
   for that boot, and attempts that never left the device are bounded by a clock
   instead. A boot therefore spends at most what one resume can spend — three
   `login` calls against a lockout threshold of ten. **Measured**: the same failure
   that once spent eighteen and locked the account now spends three. The lockout it
   protects against is narrower than it sounds and worse than it sounds: the
   throttle counts per account **and** per peer, and the peer half is random for
   each app start, so a set can only lock out itself and only until it restarts —
   but the first thing it locks out is the sign-in screen it falls through to
   seconds later, in front of a viewer who has the correct password. The lever that
   cleans the device up is the same as always: **change the password** before
   deleting the account. (measured, plus asserted by `test:signin-vault`)
8. **Nothing reports whether a given set's wrapping key is held in hardware.**
   `secureKeyStatus()` can tell `strongbox`, `tee` and `software` apart, and no
   shipped screen calls it. On a set with a software key store and no lock screen,
   "reading the app's private files is not enough" is a much weaker statement than
   on a set with a TEE, and an operator cannot tell the two apart. (reasoned)
9. **The account rendezvous cannot be revoked for one device.** The rendezvous
   secret commits to the account's `tokenVersion`, so a password reset, "log out
   all devices" and disabling the account each move the whole household to a new
   rendezvous. *Revoke device* deliberately does not bump `tokenVersion` — the same
   cooperative-sessions model as item 1 of the register below — so a device revoked
   on its own keeps calculating the rendezvous secret, keeps meeting the other
   devices, and keeps being able to change what they show. The lever that removes a
   device from "play on my TV" is **log out all devices**, not revoke. A per-device
   rendezvous key would be a protocol change. (reasoned from `panel/src/ops.js`,
   which is explicit that `revokeDevice` does not bump `tokenVersion`; the
   derivation and the epoch roll are asserted by `test:remote-core`)
10. **One compromised device on an account can drive and observe the others.**
    Membership is knowledge of one account-wide secret. Any device that holds it
    can change any television's channel to anything that television is entitled
    to, stop it, list what it is entitled to, and watch what it shows. This is the
    deliberate shape of the feature: a confirmation prompt on a television would
    need the remote control the feature exists to avoid. `setRemoteAccept(false)`
    on a given set is the only mitigation inside the protocol. Per-device
    authorisation would be a protocol change. (asserted, `test:remote-control`)
11. **The parental-PIN gate on a remote play is an obligation of the host app.**
    The engine checks entitlement and then deliberately does not tune. It emits the
    command with `restricted` on it, and the host must put a restricted channel
    through the same PIN gate a local zap goes through. Where the engine cannot
    read the channel's record it refuses the play instead of guessing at the flag,
    so it never reports a parental state it did not read. Where it *can* read it,
    nothing enforces the gate at the SDK boundary: a host that ignores `restricted`
    has no parental control on this path, and the engine cannot tell. (the refusal
    and the strict flag are asserted by `test:remote-control`; that the gate itself
    cannot be enforced from here is a property of the boundary, not a test result)
12. **A device's name on the rendezvous is its own claim.** `deviceId`, `label`
    and `role` are authenticated only as far as "some device of this account". The
    proof covers the account secret, not the identity sent after it. Two devices
    given the same id both answer to it, and a compromised device of the household
    can present any id or role it likes. The panel's device list is the authority
    on identity everywhere else. This is a handle for a picker, not a credential.
    (`test:remote-control` asserts that identity is sent only after a proof and
    cannot be rewritten later on the same channel; that the values themselves are
    unbound to a device is reasoned)
13. **A cast session serves one channel's decrypted content on one private LAN
    address, for the length of the session.** Anyone who can reach that address and
    holds the URL can fetch that channel until the session ends. The session ends
    on `stopCast()`, on engine `stop()`, and on its own if the pinned feed is
    purged or a retune fails to return a drive — the last three raise a `cast`
    event with `state: 'ended'`, and `stopCast()` does not, because the caller that
    asked for it already knows. **On the Bare runtime the listening socket is
    released only after every connection drains**, so one connection that never
    settles can hold the port past `stopCast()`. The session, the token and the
    pinned drive are already gone by then, so such a listener answers 404 to
    everything — but the port stays open, and the only trace is a breadcrumb that
    reaches an operator only if the viewer files a problem report. (asserted,
    `test:cast`; the Bare socket behaviour is reasoned from the installed source)
14. **The cast session token is a scope, not a secret the network keeps —
    measured, not assumed.** The URL is given to the receiver as the media
    `contentId`. On a TCL Google TV running the stock Default Media Receiver, a
    process that had never seen the URL and presented no credential connected on
    port 8009, joined the running session, and read `contentId` in full — the whole
    URL, token included. **On a shared network the default boundary is therefore
    "anyone who can reach the television"**, not "anyone who holds the token". The
    token is still the right mechanism (a stock receiver cannot send an
    authentication header, the token scopes a session to one channel, it dies with
    the session, and it makes blind scanning useless) but it is not access control
    on a network you do not trust. `startCast({ receiverHost })` pins the session
    to the receiver's address and raises the bar to "recover the URL **and** hold a
    position on the network that answers as the television". It is **off by
    default**, because the SDK does not speak the Cast protocol and cannot find the
    address itself; only the app that launched the session knows it. A multi-room
    group fetches from every member, so pin every member or leave the pin off for
    groups, and an empty list throws instead of meaning "unpinned". Treat an
    unpinned session on café or hotel Wi-Fi as **entitlement to that one channel,
    extended to the local network, for the length of the session**. (measured on
    one set, on firmware it has since replaced; the refusals are asserted by
    `test:cast`)
15. **`advertiseHost` is the only thing that can widen the bind.** An address the
    SDK picked itself is always one this device owns, and is what the server binds
    to. An `advertiseHost` the device does **not** own — a hostname, a NAT address,
    a forwarded address — falls back to a bind on all interfaces: the VPN tunnel,
    container bridges, mobile data, and a public address if the device has one.
    That is the caller's explicit request and nothing warns about it. (asserted,
    `test:cast`)
16. **The advertised address is a guess.** The operating system's interface list
    carries no route metric, no gateway and no link state, so Wi-Fi, a Hyper-V,
    WSL or Docker bridge, and carrier CGNAT are all private addresses and cannot be
    told apart. The session reports every private candidate in pick order, so a
    host can offer another one instead of leaving the viewer with a receiver that
    never connects. (asserted, `test:cast`)
17. **Cross-origin reads on the cast server are enabled by measurement, not by
    preference.** The receiver page is served from `https://www.gstatic.com`, so
    every media fetch it makes is cross-origin: with the header removed, the
    measured receiver fetched the playlist and **zero segments**. The cost is that
    `Access-Control-Allow-Origin: *` is on **every** response, including 404, 405
    and 500, and `OPTIONS` is answered `204` before the token is checked. So the
    server can be identified positively on the network, and from a browser, with no
    token. Existence and identity leak; content does not. (the requirement is
    measured on one set; the header and status behaviour are asserted by
    `test:cast`)
18. **Expired-block reclaim is off for a cast-pinned feed, so disk grows by about
    the channel bitrate for the session** — roughly 0.9 GB per hour at 2 Mbit/s.
    This is deliberate: blocks below the live window are already unfetchable across
    the swarm, so this device's replica is the only thing that can still serve a
    receiver that fell behind. `stopCast()` runs one reclaim pass itself. **An app
    killed in the middle of a cast never reaches it** and strands about that much —
    around 2.7 GB for a three-hour cast — until the viewer tunes that channel again
    or the replica is evicted. (asserted for the normal stop, `test:cast`; the
    app-kill path is reasoned)
19. **A revoked grant does not end a live cast session.** Entitlements for P2P
    channels are read at login, so revocation applies at the next login, exactly as
    for local playback. The cast surface makes that visible on the LAN instead of
    only on the device. Grant removal plus stream-key rotation stays the real
    revocation boundary. (reasoned)

## What this does NOT protect against

- A **live** pretext during a phone-to-TV sign-in: an attacker who talks to the
  viewer in real time can walk them through both viewer checks (see above).
- A peer on the same network reading a **cast URL** off the television and
  fetching that channel for the length of the session (see above).
- One compromised device of an account **driving and observing** the other devices
  of that account over the rendezvous (see above).
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
documented rather than implemented. The register for "send to TV", "play on my
TV" and casting is [a separate list above](#residual-risks-for-send-to-tv-play-on-my-tv-and-casting);
items 8 and 9 here belong to both.

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
