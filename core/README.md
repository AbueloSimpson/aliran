# @aliran/core

Shared crypto (plus two infra helpers) for the [Aliran](https://github.com/AbueloSimpson/aliran)
peer-to-peer OTT streaming platform. Runs in **Node (>= 20)** and in the **Bare**
runtime (the Android app's worklet) — no Node-only APIs in the crypto modules.

Every panel, broadcaster, repeater, and player in an Aliran deployment agrees on
these primitives; the [security model](https://abuelosimpson.github.io/aliran/security-model/)
documents how they compose.

## Modules

`index.js` re-exports the five crypto modules. The two infra helpers are imported
by path (they are Node/Bare plumbing, not crypto).

| Module | Exports | Purpose |
|---|---|---|
| `oprf.js` | `oprfKeyGen` `blind` `evaluate` `evaluateFull` `finalize` | OPRF over ristretto255 ([@noble/curves](https://github.com/paulmillr/noble-curves)) — the login protocol's core: the panel never sees a plaintext password, the client never sees the OPRF key. |
| `password.js` | `randomSalt` `deriveVerifier` `verify` `wrapKeyFrom` `wrap` `unwrap` `ARGON2_DEFAULT` `SALT_BYTES` | Argon2id verifiers + XSalsa20-Poly1305 secretbox wrapping of per-user key material (sodium-native). |
| `keybox.js` | `userKeyPair` `sealTo` `sealOpen` `authKeyPair` `authSign` `authVerify` | X25519 sealed boxes (granting stream keys to a user) + Ed25519 signatures (proving a login/session). |
| `token.js` | `signToken` `verifyToken` `tokenValid` | Panel-signed session tokens. |
| `pow.js` | `powSolve` `powVerify` | Proof-of-work gate for unauthenticated RPCs. |
| `net-tune.js` (by path) | `tuneSwarm` `tuneSocket` `readKernelCeilings` `evaluateBuffer` `logSwarmTuning` … | Hyperswarm UDP socket-buffer sizing + honest clamp detection ([why](https://abuelosimpson.github.io/aliran/kb/network-tuning/)). |
| `store-gc.js` (by path) | `purgeStaleCores` `DISCOVERY_HEX_RE` | Reclaims stray Corestore core directories not on a keep-list. |

```js
import { blind, finalize, deriveVerifier, sealOpen, tokenValid } from '@aliran/core'
import { tuneSwarm } from '@aliran/core/net-tune.js'
```

## Caveat

The OPRF group math uses the audited `@noble/curves` ristretto255 implementation;
Argon2id and secretbox use `sodium-native`. The **composition** is Aliran's own —
have it independently reviewed before betting production credentials on it.

## Test

```sh
npm test   # node test.mjs — fast, no network
```

MIT — part of the [Aliran monorepo](https://github.com/AbueloSimpson/aliran).
