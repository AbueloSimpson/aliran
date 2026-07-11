# @aliran/tools

Developer tools for testing the P2P streaming path **without an Android build**.

## Desktop viewer

Replicates a broadcaster's encrypted feed over Hyperswarm and serves it on localhost,
so you can play it in VLC / a browser. This is the reference implementation the client's
Bare worklet mirrors (`client/backend/backend.mjs`).

```bash
# 1. Start the broadcaster (prints feedKey + encKey)
cd ../broadcaster && node src/index.js

# 2. In another terminal, point the viewer at those keys
node ../tools/viewer.js <feedKeyHex> <encryptionKeyHex>
# -> http://127.0.0.1:<port>/index.m3u8  (open in VLC)
```

## End-to-end test

Spins up a broadcaster + a fresh viewer peer over the real DHT and validates the
delivered media with `ffprobe`. Requires `ffmpeg`/`ffprobe` on PATH and outbound UDP.

```bash
node tools/e2e-stream-test.mjs   # exits 0 on PASS
```

This is the automated proof of the **v0.1 "it streams"** milestone: an encrypted feed is
produced by ffmpeg, seeded on Hyperswarm, discovered + replicated by a separate peer,
served over localhost with HTTP Range, and confirmed to be valid H.264/AAC.

## Login end-to-end test (v0.2)

```bash
node tools/e2e-login-test.mjs    # exits 0 on PASS
```

Proof of the **v0.2 secure-login** milestone: a panel serves the OPRF login RPC and
replicates a signed account/catalog DB; a client logs in (proof-of-work → blinded OPRF →
verify → unwrap its keys), resolves the granted stream, replicates the encrypted feed,
and plays it (ffprobe-validated). Wrong passwords are rejected.

## All tests

```bash
npm run test:core     # @aliran/core crypto unit tests (fast, no ffmpeg/network)
npm run test:stream   # v0.1 streaming e2e (needs ffmpeg + DHT)
npm run test:login    # v0.2 login e2e (needs ffmpeg + DHT)
```
