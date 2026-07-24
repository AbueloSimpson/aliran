// Tiny persistence layer for the reseller panel's JSON state. Two jobs:
//
//   1. Atomic file writes: write <file>.tmp then rename over the original, so a
//      crash mid-write can never leave a half-written accounts.json/principals.json
//      (rename replaces atomically on POSIX; Node maps it to MOVEFILE_REPLACE_EXISTING
//      on Windows).
//   2. ONE global async mutex. Every sequence that touches ledger + accounts +
//      the panel API runs inside it, serialized — balances are checked and spent
//      in the same critical section, so no interleaving can over-spend. At this
//      service's traffic level, correctness beats concurrency.

import fs from 'fs'
import path from 'path'

export function readJsonFile (file, fallback) {
  if (!fs.existsSync(file)) return fallback
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJsonFile (file, obj, { mode } = {}) {
  // A restrictive file mode (0600 — principals, control keys) marks a secret; its
  // directory is created owner-only (0700). Non-secret state dirs keep the default.
  fs.mkdirSync(path.dirname(file), { recursive: true, ...(mode ? { mode: 0o700 } : {}) })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), mode ? { mode } : {})
  fs.renameSync(tmp, file)
}

// Promise-chain mutex: run(fn) executes fn after every previously enqueued fn has
// settled, and returns fn's own promise (rejections propagate to the caller but
// never break the chain).
export function makeMutex () {
  let tail = Promise.resolve()
  return function run (fn) {
    const p = tail.then(() => fn())
    tail = p.then(() => {}, () => {})
    return p
  }
}
