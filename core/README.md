# @aliran/core

Shared crypto (plus two infra helpers) for the [Aliran](https://github.com/AbueloSimpson/aliran)
peer-to-peer OTT streaming platform. It runs in **Node (>= 20)** and in the
**Bare** runtime (the Android app's worklet) — the crypto modules use no
Node-only APIs.

Every panel, broadcaster, repeater, and player in an Aliran deployment agrees on
these primitives. The [security model](https://abuelosimpson.github.io/aliran/security-model/)
documents how they fit together.

## Modules

`index.js` re-exports the five crypto modules. You import the three infra helpers
by path — they are Node/Bare plumbing, not crypto. Each one reads or writes the
disk, so `index.js` keeps them out: the client bundles `index.js` into the Bare
worklet, which has no `fs`.

| Module | Exports | Purpose |
|---|---|---|
| `oprf.js` | `oprfKeyGen` `blind` `evaluate` `evaluateFull` `finalize` | OPRF over ristretto255 ([@noble/curves](https://github.com/paulmillr/noble-curves)) — the login protocol's core: the panel never sees a plaintext password, and the client never sees the OPRF key. |
| `password.js` | `randomSalt` `deriveVerifier` `verify` `wrapKeyFrom` `wrap` `unwrap` `ARGON2_DEFAULT` `SALT_BYTES` | Argon2id verifiers + XSalsa20-Poly1305 secretbox wrapping of per-user key material (sodium-native). |
| `keybox.js` | `userKeyPair` `sealTo` `sealOpen` `authKeyPair` `authSign` `authVerify` | X25519 sealed boxes (granting stream keys to a user) + Ed25519 signatures (proving a login/session). |
| `token.js` | `signToken` `verifyToken` `tokenValid` | Panel-signed session tokens. |
| `pow.js` | `powSolve` `powVerify` | Proof-of-work gate for unauthenticated RPCs. |
| `net-tune.js` (by path) | `tuneSwarm` `tuneSocket` `readKernelCeilings` `evaluateBuffer` `logSwarmTuning` … | Hyperswarm UDP socket-buffer sizing + honest clamp detection ([why](https://abuelosimpson.github.io/aliran/kb/network-tuning/)). |
| `store-gc.js` (by path) | `purgeStaleCores` `DISCOVERY_HEX_RE` | Reclaims stray Corestore core directories not on a keep-list. |
| `bee-watch.js` (by path) | `watchRange` | A Hyperbee range watch that survives a hypercore **fork**. A raw `bee.watch()` goes permanently deaf when the core is truncated — it either throws `SNAPSHOT_NOT_AVAILABLE` or parks silently for ever, and hyperbee's apparent fork guard cannot fire. This re-creates the watcher on the core's `truncate` event and re-reads the range once per re-arm. |
| `atomic-write.js` (by path) | `writeFileAtomic` `writeJsonAtomic` `atomicTmpPath` `isAtomicTmp` | Replaces a file safely. It writes a temp file beside the target, flushes it to disk, then renames it over the target. A crash during the write cannot truncate the file. Secrets get their `0600` mode before the rename, so no other user can read them. |

```js
import { blind, finalize, deriveVerifier, sealOpen, tokenValid } from '@aliran/core'
import { tuneSwarm } from '@aliran/core/net-tune.js'
```

## Caveat

The OPRF group math uses the audited `@noble/curves` ristretto255 implementation.
Argon2id and secretbox use `sodium-native`. Aliran wrote the **composition**
itself — have it independently reviewed before you bet production credentials on it.

## Test

```sh
npm test   # node test.mjs — fast, no network
```

MIT — part of the [Aliran monorepo](https://github.com/AbueloSimpson/aliran).
