# FAQ & Troubleshooting

!!! tip "Hitting a specific error?"
    The [knowledge base](kb/index.md) has field-tested **symptom → cause → fix**
    entries for playback, operations, Android builds, and the Bare worklet — search
    it for the error text you're seeing.

## Concept FAQ

**Is this "Pear as an Android app"?**
No — Pear the runtime can't be packaged as an APK. Aliran ships the Holepunch *stack*
(Bare + Hyperswarm + Hyperdrive) inside a React Native app, the way Keet does. See
[concepts.md](concepts.md).

**Do I need servers?**
No central media servers. The **panel** is a lightweight authority for accounts/catalog
and is only needed for *new* logins; it runs behind a firewall with no inbound ports.
Streaming and catalog reads are fully peer-to-peer.

**How does it scale cheaply?**
Viewers re-seed each other (Hyperswarm mesh), so distribution capacity grows with the
audience instead of costing you bandwidth.

**Can I stop unauthorized people from watching?**
Yes — content is encrypted and keys are delivered only to entitled users. You cannot
stop someone from *connecting* to a public swarm topic, but ciphertext is useless
without a key. See [security-model.md](security-model.md).

**Is my login safe from brute force if someone copies the database?**
Yes, provided the panel is reachable at login: password verification is bound to the
panel's OPRF key, so guesses can't be tested offline. Returning users work offline via
cached sessions; new logins require the panel.

**Does it support DRM / geo-blocking?**
No — deliberately, and it isn't planned. Content protection is encrypted feeds +
per-user sealed keys + stream-key rotation (honest access control, with its limits
stated in the [security model](security-model.md#no-drm-no-geo-locking-deliberately)).
There is no geo-restriction; territorial obligations are the operator's to satisfy
contractually. If your content requires studio DRM, this platform is the wrong tool
for it.

## Troubleshooting

**Client can't find the panel.**
Confirm `panelPubKey` in `client/config/service.json` matches the panel's printed key.
Both must be able to reach the DHT (outbound UDP). Very restrictive networks (double
symmetric NAT) may need relay/bootstrap tuning.

**Playback never starts / spinner forever.**
Check the broadcaster is seeding (feed key printed, ffmpeg producing segments) and that
the client's localhost server got a port (backend `{ type: 'port' }` message). Ensure
`127.0.0.1` cleartext is allowed in the Android network security config.

**`react-native-bare-kit` build fails.**
It needs a real native build (JDK 17, Android SDK 34, NDK, CMake) — not Expo Go. Run
`npx react-native doctor`. See [client-build.md](client-build.md).

**Android TV: focus/navigation doesn't work.**
Ensure the app was built with `react-native-tvos` and screens use focusable elements
(`hasTVPreferredFocus`, `TVFocusGuideView`).

**Login is rejected / account locked.**
Repeated failures trigger the panel lockout. Clear it with
`node src/admin-cli.js unlock <username>`.

**I lost my panel keys.**
The OPRF/signing keys are unrecoverable if not backed up — every account depends on
them. Always back up `DATA_DIR/keys`. See [operator-guide.md](operator-guide.md).
