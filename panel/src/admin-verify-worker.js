// Argon2id verification for panel-admin logins, off the main thread.
//
// crypto_pwhash is synchronous and memory-hard (the verifier's recorded cost —
// 64 MiB by default), so on the main thread every login attempt freezes the
// event loop for the whole grind: admin API, catalog/assets replication, the
// viewer login RPC, everything. The broadcaster control API had this exact
// defect (2026-07-16 login-flood incident: 4-5 POSTs = 25+ min outage) — this
// is the panel-side port of that fix. This worker keeps the loop free;
// makeAdminVerifier (ops.js) owns the single-flight + timeout policy around it.

import { parentPort } from 'worker_threads'
import b4a from 'b4a'
import { verify } from '@aliran/core'

parentPort.on('message', ({ id, password, saltHex, verifierHex, argon }) => {
  let ok = false
  try {
    ok = verify(b4a.from(password), b4a.from(saltHex, 'hex'), b4a.from(verifierHex, 'hex'), argon)
  } catch {}
  parentPort.postMessage({ id, ok })
})
