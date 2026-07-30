// Crash-safe file writes: write a sibling temp file, fsync it, rename it over the target.
//
// NOT re-exported from index.js on purpose (same reason as net-tune.js and store-gc.js):
// this module touches the filesystem and is server-side only, while index.js is bundled
// into the Bare worklet. Import it by path:
//   import { writeJsonAtomic } from '@aliran/core/atomic-write.js'
//
// WHY THIS EXISTS
//
// A plain fs.writeFileSync onto a live path is destructive from its first byte: the file is
// truncated to zero, THEN refilled. Anything that stops the process in between — an OOM kill,
// a segfault, power loss, or a `docker stop` that outruns the stop grace — leaves a truncated
// or half-written file, and the next boot reads that instead of the registry. The registries
// this protects have no other copy on disk:
//
//   broadcaster channels.json  — every channel's config PLUS push stream keys, SRT
//                                passphrases and CENC decryption keys
//   panel secrets/streams.json — the per-stream encryption keys that user grants seal;
//                                lose them and every existing grant is worthless
//   library secrets/titles.json — the same role for VOD: minted once per title and reused
//                                across re-ingests, so sealed grants survive
//   panel/broadcaster/library secrets/admins.json, panel secrets/publishers.json,
//   panel packages.json + sources.json, library titles.json
//
// THE RECIPE, and why each step is there
//
//   1. temp file in the SAME DIRECTORY as the target. rename() is only atomic within one
//      filesystem; across one it degrades to copy-then-delete, which reintroduces exactly
//      the torn-write window this exists to close. Never use os.tmpdir() here.
//   2. open with 'w' (truncate). A .tmp left behind by an earlier crash therefore contributes
//      no bytes — it is overwritten, never appended to.
//   3. fchmod to the requested mode. open()'s mode argument applies ONLY when it creates the
//      file, so a stale .tmp from a crash could otherwise carry a looser mode into the live
//      path. The secret is 0600 from creation and never briefly world-readable.
//   4. fsync the temp file BEFORE the rename (see below).
//   5. rename over the target. Atomic: a reader sees either the whole old file or the whole
//      new one, never a mix. rename also carries the temp file's mode with it, which is why
//      no post-hoc chmod is needed on the live path.
//   6. unlink the temp file if any of the above throws, so a failed write leaves no litter.
//
// A leftover .tmp cannot be mistaken for real data. Every loader of these files opens an
// EXACT path (channels.json, streams.json, …), so none of them can see a sibling. The
// directory scanners that do walk these dirs never parse what they find: the analytics prune
// passes match names against a `\.json$`-anchored regex, and the panel's dirSize() only adds
// up bytes. A stale .tmp is therefore inert until the next write truncates it. Callers that
// grow a new scanner should filter with isAtomicTmp() rather than re-deriving the suffix.
//
// WHY fsync, and what it costs
//
// rename is atomic with respect to ORDER but says nothing about DURABILITY: the temp file's
// data blocks may still be sitting in the page cache when the rename lands in the journal.
// A process-level crash (OOM, segfault, docker stop) is safe without fsync — the page cache
// belongs to the kernel and outlives the process. POWER LOSS is not: some filesystems can
// then present the renamed file with unwritten blocks, i.e. the zero-filled file we were
// trying to prevent. ext4's auto_da_alloc heuristic covers the common rename-over-existing
// case, but it is a heuristic on one filesystem, not a guarantee.
//
// So fsync is ON by default. Measured on a 44 KB channels.json shaped like production's 84
// channels (Windows/NTFS dev box, 200 writes): 1.49 ms/write rename-only vs 5.40 ms/write
// with fsync — +3.9 ms. Every caller is a human-scale write (a channel add/patch/start/stop,
// an admin change, a package edit), so that is invisible. The worst case in the tree is the
// boot-time resume of every channel, one fsync per start: +330 ms against a ramp that already
// takes ~58 s. Nothing writes per segment or on a watchdog tick, so there is no hot path to
// protect. `fsync: false` exists for tests and for genuinely disposable data.
//
// The directory fsync afterwards makes the RENAME itself durable. It is best-effort: opening
// a directory for fsync is not portable (it fails on Windows, where dev happens), and its
// failure mode is benign — losing the rename leaves the previous file intact, which is stale
// but never torn. Corruption is what fsync of the temp file already prevents.

import fs from 'fs'
import path from 'path'

const TMP_SUFFIX = '.tmp'

// The temp path writeFileAtomic uses for `file`. Exposed so directory scanners and tests
// filter on the real suffix instead of hardcoding it.
export function atomicTmpPath (file) { return file + TMP_SUFFIX }

export function isAtomicTmp (name) { return typeof name === 'string' && name.endsWith(TMP_SUFFIX) }

// Best-effort fsync of a directory, to persist the rename entry itself. Swallows errors:
// not portable (EISDIR/EPERM on Windows), and the fallback is the intact previous file.
function syncDir (dir) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {} finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
}

// Atomically replace `file` with `data`.
//   mode    — file mode for the RESULT (0o600 for anything holding a secret). Applied to the
//             temp file before the rename carries it over, so the window where a secret could
//             be read by another user never exists.
//   dirMode — mode for directories mkdir has to CREATE (0o700 for a secrets dir). Never
//             touches an existing directory, matching mkdirSync's own recursive semantics.
//   fsync   — flush before renaming. Default true; see the header.
export function writeFileAtomic (file, data, { mode, dirMode, fsync = true } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, ...(dirMode != null ? { mode: dirMode } : {}) })

  const tmp = atomicTmpPath(file)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w', mode != null ? mode : 0o666)
    // open()'s mode only lands on a file it CREATED — force it, so a stale .tmp cannot
    // hand a looser mode to the live path. No-op on Windows, which has no POSIX modes.
    if (mode != null) { try { fs.fchmodSync(fd, mode) } catch {} }
    fs.writeFileSync(fd, data)
    if (fsync) fs.fsyncSync(fd)
    fs.closeSync(fd); fd = null
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
  if (fsync) syncDir(dir)
  return file
}

// JSON convenience wrapper. `indent` defaults to 2 (what every registry in the tree uses);
// pass 0 for the compact form the analytics rollups write.
export function writeJsonAtomic (file, value, { indent = 2, ...opts } = {}) {
  return writeFileAtomic(file, JSON.stringify(value, null, indent), opts)
}
