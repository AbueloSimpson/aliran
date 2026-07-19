// Replica-store corruption recovery — runtime-agnostic (runs in Bare and in Node).
// Canonical home since the SDK extract; client/backend/recover.mjs re-exports this file.
//
// The client's Corestore is a pure replica cache: every byte in it (panel DB, assets
// drive, feed drives) re-replicates from peers. If the app process dies mid-write
// (emulator GPU crash during playback, task kill), hypercore can permanently refuse to
// reopen a core — e.g. `OPLOG_CORRUPT: Oplog file appears corrupt or out of date` —
// and without recovery the user is stuck until they wipe app data by hand. The cure is
// simply to throw the cache away and let it re-replicate.

// hypercore-errors codes that mean "the on-disk state is unreadable", as opposed to
// transient network/usage errors. The message test is a fallback for errors that were
// wrapped or re-thrown and lost their code. EPARTIALREAD ("Could not satisfy length") is a
// random-access truncation error — a core whose oplog/tree was cut off when the process was
// killed mid-write; without it a store truncated by an unclean exit would never recover.
const CORRUPT_CODES = ['EPARTIALREAD', 'OPLOG_CORRUPT', 'OPLOG_HEADER_OVERFLOW', 'INVALID_OPLOG_VERSION', 'INVALID_CHECKSUM', 'DECODING_ERROR']

export function isCorruptionError (err) {
  if (!err) return false
  if (CORRUPT_CODES.indexOf(err.code) >= 0) return true
  return /corrupt|could not satisfy length/i.test(String(err.message || err))
}

// Run `op`. If it fails because the store is corrupt: `purge()` (drop the cache from
// disk and rebuild whatever base state ops rely on), then retry `op` once. Any second
// failure — and any non-corruption failure — propagates to the caller unchanged.
export async function withRecovery (op, purge, onRecover) {
  try {
    return await op()
  } catch (err) {
    if (!isCorruptionError(err)) throw err
    if (onRecover) { try { onRecover(err) } catch {} }
    await purge(err)
    return op()
  }
}
