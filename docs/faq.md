# FAQ & Troubleshooting

!!! tip "Hitting a specific error?"
    The [knowledge base](kb/index.md) has field-tested **symptom → cause → fix**
    entries for playback, operations, Android builds, and the Bare worklet. Search
    it for the error text you're seeing.

## Concept FAQ

**Is this "Pear as an Android app"?**
No. Pear the runtime can't be packaged as an APK. Aliran ships the Holepunch
*stack* — Bare, Hyperswarm, and Hyperdrive — inside a React Native app, the same
way Keet does. See [concepts.md](concepts.md).

**Do I need servers?**
No central media servers. The **panel** is a lightweight authority for accounts
and the catalog. It is only needed for *new* logins, and it runs behind a
firewall with no inbound ports. Streaming and catalog reads are fully
peer-to-peer.

**How does it scale cheaply?**
Viewers re-seed each other over a Hyperswarm mesh. Distribution capacity grows
with the audience, instead of costing you more bandwidth.

**Can I stop unauthorized people from watching?**
Yes. Content is encrypted, and keys go only to viewers with a grant. You cannot
stop someone from *connecting* to a public swarm topic, but ciphertext is
useless without a key. See [security-model.md](security-model.md).

**Is my login safe from brute force if someone copies the database?**
Yes, provided the panel is reachable at login. Password verification is bound
to the panel's OPRF key, so an attacker can't test guesses offline. Returning
viewers work offline using a cached session; a new login needs the panel.

**Does it support DRM / geo-blocking?**
No, deliberately, and this isn't planned. Content protection is encrypted
feeds, per-user sealed keys, and stream-key rotation — honest access control,
with its limits stated in the
[security model](security-model.md#no-drm-no-geo-locking-deliberately). There
is no geo-restriction. Territorial obligations are the operator's to satisfy
contractually. If your content requires studio DRM, this platform is the
wrong tool for it.

## Troubleshooting

**Client can't find the panel.**
Confirm `panelPubKey` in `client/config/service.json` matches the panel's
printed key. Both sides must be able to reach the DHT over outbound UDP. Very
restrictive networks (double symmetric NAT) may need relay or bootstrap
tuning. The discovery mechanics — topics, bootstrap overrides, hole-punching,
and its relay fallback — are explained in
[How peers find each other](concepts.md#how-peers-find-each-other).

**Playback never starts, or the spinner runs forever.**
Check that the broadcaster is seeding: the feed key prints, and ffmpeg is
producing segments. Check that the client's localhost server got a port (the
backend sends a `{ type: 'port' }` message). Make sure the Android network
security config allows `127.0.0.1` cleartext.

**`react-native-bare-kit` build fails.**
It needs a real native build — JDK 17, Android SDK 34, NDK, and CMake — not
Expo Go. Run `npx react-native doctor`. See [client-build.md](client-build.md).

**Android TV: focus or navigation doesn't work.**
Make sure the app was built with `react-native-tvos`, and that screens use
focusable elements (`hasTVPreferredFocus`, `TVFocusGuideView`).

**Login is rejected, or the account is locked.**
Repeated failures trigger the panel's lockout. Clear it with `node
src/admin-cli.js unlock <username>`.

**I lost my panel keys.**
The OPRF and signing keys are unrecoverable if you don't back them up — every
account depends on them. Always back up `DATA_DIR/keys`. See
[operator-guide.md](operator-guide.md).
