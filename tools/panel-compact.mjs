#!/usr/bin/env node
// Panel Hyperbee compaction — FORK + SHADOW REBUILD + DIRECTORY SWAP.
//
// WHY THIS EXISTS
//
// The panel's signed Hyperbee (panel/src/store.js openStore) is the single-writer origin of
// truth for accounts, entitlement grants and the catalog. A Hypercore is an append-only log
// under a signed merkle tree: a `put` that supersedes a key does not free the block it
// replaced, and nothing in hypercore ever will — every block from 0..length-1 stays covered
// by the tree and is what a cold client replicates. So a write-amplification bug (the
// per-removed-channel rewrite of a ~455 KB grant map, fixed in 88da6ff) is paid for FOREVER
// in disk: on the SolTV deployment the live state is ~2,730 keys ≈ 6.5 MB sitting inside a
// 13.7 GB `data` file, and it filled the box's disk.
//
// `core.clear()` is NOT the answer here. Clearing superseded blocks punches holes in the
// middle of the log; the tree keeps every node, `contiguousLength` collapses, and any client
// that replicates from block 0 stalls on bytes no peer has. The only way to make the log
// SHORT is to write a new one — same key, same signature chain, at a NEW FORK.
//
//   dump    read every live entry out of the live core, raw bytes, read-only
//   rebuild replay them into a fresh core with the SAME keypair, truncated to fork+1
//   verify  prove, in a separate process, that the new core is the old one's live state —
//           against the dump AND against the live bee directly
//   swap    open the live core, prove it is still the one that was dumped, then move it OUT
//           of DATA_DIR and move the new one into its place
//
// THE LIVE CORE IS THE AUTHORITY, NOT THE DUMP SIDECAR
//
// Two things follow from this and neither is optional. First, `verify` compares the shadow to
// the LIVE bee, not only to the dump: a dump's own key count and checksum are computed in the
// same pass that writes it, so a dump that was SHORT is perfectly self-consistent and every
// dump-only check passes. Second, `swap` OPENS the live core before it moves anything and
// requires it to be byte-for-byte the core the dump was taken from, with the shadow at exactly
// liveFork+1 computed from that core. Validating against the sidecar instead lets an operator
// re-run the runbook from a saved dump after a previous swap and install a SECOND core at a
// fork the live one already occupies — same key, different blocks, which is the unrecoverable
// case described below. Opening the core also takes the OS lock every core file holds, so a
// panel that was never stopped surfaces as ELOCKED instead of having its open fds silently
// follow the directory into the rollback (rename(2) on a directory with open files SUCCEEDS on
// Linux; the panel would keep writing into a copy that vanishes at restart).
//
// THE FORK+1 RULE (do not "simplify" this)
//
// hypercore/lib/core.js:841-843 `checkConflict` returns false immediately when
// `proof.fork !== this.tree.fork`. A client holding the OLD core sees a higher fork, treats
// it as a legitimate truncate+rewrite, and re-syncs. Rebuilding at the SAME fork instead
// hands every client a DIFFERENT block at a sequence number it already has — a genuine
// conflict, which calls `_closeAllSessions` and kills the session unrecoverably. fork is a
// signed field (hypercore/lib/caps.js `treeSignable` encodes it alongside length), so the new
// log is signed as a legitimate continuation, not a forgery. `truncate(0, { fork })` needs no
// signature at all (core.js only signs when `length > 0`).
//
// THE ROLLBACK RULE (this one is structural, and it is why rollbackDir is a required flag)
//
// panel/src/store.js `reclaimStrayCores` runs on EVERY panel start and hands
// core/store-gc.js `purgeStaleCores` a keep-set of the five cores the panel owns. That
// function `fs.rmSync(..., {recursive:true, force:true})` every directory under
// <DATA_DIR>/cores/**/ whose name matches /^[0-9a-f]{64}$/ and is not in the keep set. Park
// the pre-swap 13.7 GB core anywhere inside <DATA_DIR>/cores/ and the panel DELETES THE ONLY
// ROLLBACK the next time it boots. A `<disc>.old` suffix happens to dodge that regex today,
// which is a one-character safety margin on data with no peer to restore from. So the swap
// moves the old core OUTSIDE DATA_DIR entirely, and refuses if you point it back inside.
// Same filesystem, because a rename must be atomic and instant — it moves a directory ENTRY,
// so the 13.7 GB never moves and the volume needs no headroom for it.
//
// WHY A CORE DIRECTORY CAN BE SWAPPED BETWEEN STORES AT ALL
//
// corestore/index.js `getStorageRoot(id)` is `cores/<id[0:2]>/<id[2:4]>/<id>` keyed by
// DISCOVERY key — pure function of the public key, identical in every store, with no
// store-level index anywhere (a store dir is just `cores/` + `primary-key`). And a core
// opened by explicit `keyPair` — which is exactly what openStore does — gets `userData = {}`
// (corestore/index.js ~:301-305), so the core carries nothing that ties it to the store that
// built it. The directory is self-describing; moving it is the whole trick.
//
// RUNNING IT IN THE PANEL CONTAINER
//
// This file is SELF-CONTAINED on purpose: node built-ins plus corestore, hyperbee,
// hypercore-crypto and b4a, which are the panel's own direct dependencies. It imports nothing
// from panel/src or any other workspace package, because on the box there is no repo checkout
// — the image has its code at /app/panel/src and its deps at /app/panel/node_modules, with no
// /app/tools and no root node_modules. Bind-mounting this ONE file next to those deps is what
// makes it run against the EXACT deployed module versions:
//
//   docker run --rm --network none \
//     -v aliran_panel-data:/data \
//     -v /root/panel-compact/panel-compact.mjs:/app/panel/panel-compact.mjs \
//     -v /root/panel-compact/work:/work \
//     --entrypoint node aliran-panel \
//     /app/panel/panel-compact.mjs report --data-dir /data
//
// A single relative import of panel/src/* would break that, since paths relative to
// /app/panel/panel-compact.mjs do not land where a repo checkout would put them. Keep it one
// file. Every path is a flag; nothing is hardcoded.
//
// It also never calls panel/src/keys.js openKeys(): that chmods keys/ and secrets/ as a side
// effect (ensureDirMode), which is a MUTATION of the live data directory and would invalidate
// the dump's own read-only evidence. signing.json is read with plain fs, and `dump` takes only
// the public half — pass --public-key and it never opens the secret-bearing file at all.
//
// PICKING --rollback-dir (the one flag that is not obvious inside a container)
//
// It must be OUTSIDE DATA_DIR (see above) and on the SAME FILESYSTEM as it, because the move
// has to be a rename. Inside the container that is not simply "a sibling directory": /data is
// a mounted volume, so the container's own / is a different filesystem and a bare `mkdir
// /rollback` would fail with EXDEV. The rollback needs its own bind mount whose HOST path sits
// on the same host filesystem as the panel volume's host path — for a default install that is
// under the docker data-root (`docker volume inspect aliran_panel-data` prints the host path).
// This tool does not take that on trust: before it moves anything it renames a probe file
// across and back, and refuses if that fails. st.dev alone is NOT enough — with the usual
// two-mount setup it can agree while the rename still returns EXDEV.
//
// Do NOT park the rollback inside the volume's own directory next to `_data`: it is on the
// right filesystem, but `docker volume rm` would then take the 13.7 GB rollback with the
// volume. Put it in a sibling directory on that filesystem, outside any volume.
//
// --out and --store have no such constraint — they are ~7 MB and can go on any writable mount.
// --out may not be inside DATA_DIR (it is the only offline copy; it does not belong on the
// volume being compacted).
//
// THE RUNBOOK. Stop the panel first — all four phases assume no writer.
//
//   1  node panel-compact.mjs dump    --data-dir /data --out /work/bee.ndjson
//   2  node panel-compact.mjs rebuild --data-dir /data --dump /work/bee.ndjson \
//                                     --store /work/shadow --fork <printed by step 1>
//   3  node panel-compact.mjs verify  --data-dir /data --dump /work/bee.ndjson \
//                                     --store /work/shadow --fork <same>
//   4  node panel-compact.mjs swap    --data-dir /data --shadow-store /work/shadow \
//                                     --rollback-dir /rollback --i-have-stopped-the-panel
//
// Run them back to back with the panel DOWN throughout. The panel writes on every start
// (openStore) and continuously while up (liveness), so any uptime between steps invalidates
// the dump — steps 3 and 4 both detect that and refuse, but the only fix is to start over.
//
// Step 3 MUST be its own process — that is the point of it. Nothing it asserts may come from
// a cache warmed by the process that did the writing. `swap` requires the receipt it writes,
// and that receipt commits to the shadow's MERKLE ROOT plus its `tree` and `data` digests, so
// it cannot be inherited by a different rebuild of the same shape. It lives INSIDE the store
// directory, so deleting the store deletes the blessing with it.
//
// IF A SWAP IS INTERRUPTED between the two renames, an intent file is left at
// <rollback>/SWAP-IN-PROGRESS.json naming both directories and the exact `mv` that undoes it,
// and the same commands are printed before the renames begin. `swap` refuses to run again
// while one exists, and `report --rollback-dir <p>` surfaces it. Do NOT start the panel with
// one outstanding: openStore would create a fresh empty core at the vacant path, which is the
// same-key-different-blocks conflict arrived at by crashing instead of by swapping.
//
// AFTERWARDS: keep /rollback until the panel has been up and serving for long enough to be
// sure. Deleting it is the only irreversible step in the whole procedure, and it is a step a
// human takes deliberately — nothing here ever deletes anything. Note that `df` does NOT move
// until you do: the rollback is on the same filesystem by design, so the bytes are still
// allocated. That is what the swap summary means by "will be freed when you delete".
//
// Every subcommand prints human text and then ONE final line of compact JSON, so:
//   node panel-compact.mjs report --data-dir /data | tail -1 | jq .

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'
import { fileURLToPath } from 'url'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'

const TOOL = 'panel-compact'
const log = (...a) => console.log(...a)
const warn = (...a) => console.log('  !!  ' + a.join(' '))
const MiB = 1024 * 1024
const fmt = (n) => (n === null || n === undefined ? 'n/a' : (n / MiB).toFixed(2) + ' MiB')

// Every assertion in this file goes through here, and every message is written for an
// operator reading a failure at 3am with a stopped panel: what was expected, what was found,
// and whether they should roll back.
//
// `msg` may be a function, and must be wherever building the message touches data that only
// exists when the assertion FAILS — argument evaluation is eager, so an inline template there
// throws a TypeError from inside the reporting path and the operator learns nothing about the
// actual problem. (That is not hypothetical: the extra-keys check below reads
// `iter.value.key`, which is null on a stream that ended, i.e. in the passing case.)
function must (cond, msg) {
  if (!cond) throw new Error(typeof msg === 'function' ? msg() : msg)
}

// --- filesystem helpers -------------------------------------------------------------------

// Corestore v6 lays every core out at cores/<dk[0:2]>/<dk[2:4]>/<dk>/ keyed by DISCOVERY key.
// Store-independent by construction — see the header.
export function coreDirFor (storeDir, publicKey) {
  const dk = b4a.toString(hcrypto.discoveryKey(toKeyBuffer(publicKey)), 'hex')
  return path.join(storeDir, 'cores', dk.slice(0, 2), dk.slice(2, 4), dk)
}

export function toKeyBuffer (k) {
  if (b4a.isBuffer(k)) return k
  must(typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k),
    `public key must be 64 hex chars or a 32-byte buffer, got ${typeof k === 'string' ? JSON.stringify(k) : typeof k} — ` +
    'this is the panel signing public key from <DATA_DIR>/keys/signing.json.')
  return b4a.from(k, 'hex')
}

const CORE_FILES = ['data', 'tree', 'bitfield', 'oplog']

// Apparent size + mtime of the four files a hypercore keeps. `data` on the live core is
// 13.7 GB, so it is never hashed; the other three are small enough to hash, which is what
// turns "unchanged" from a heuristic into evidence (see readOnlyProof).
function statParts (coreDir) {
  const out = { dir: coreDir, files: {}, total: 0 }
  for (const f of CORE_FILES) {
    try {
      const st = fs.statSync(path.join(coreDir, f))
      out.files[f] = { size: st.size, mtimeMs: st.mtimeMs }
      out.total += st.size
    } catch { out.files[f] = null }
  }
  return out
}

function hashFileMaybe (p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return null }
}

function sha256File (p) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(p, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

// A file is not on stable storage until its DIRECTORY entry is too — that is what makes a
// dump survive the power cut that a 13.7 GB rename might otherwise be blamed for. Windows
// cannot open a directory as a file handle, so this is exact on Linux (where the tool
// actually runs, inside the panel container) and honestly reported as unsupported elsewhere,
// rather than silently swallowed.
function fsyncDir (dir) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
    return { dir, synced: true }
  } catch (err) {
    if (process.platform === 'win32') return { dir, synced: false, reason: `win32 cannot fsync a directory (${err.code})` }
    throw new Error(`could not fsync directory ${dir} (${err.code}) — the rename/write into it is NOT known to be durable. ` +
      'Do not power-cycle this box until you have re-run the step.')
  } finally { if (fd !== null) try { fs.closeSync(fd) } catch {} }
}

// Containment, resolved through SYMLINKS. path.resolve alone is not enough: a --rollback-dir
// that is a symlink to <DATA_DIR>/cores/ab/cd resolves to its own lexical path and passes,
// which would park the rollback physically inside the directory the whole point is to keep it
// out of. realpath is the only thing that answers "where does this actually live".
// realpathSync throws on a path that does not exist yet — --rollback-dir usually does not.
// So resolve the nearest existing ANCESTOR and re-attach the remaining segments, which keeps
// the path's identity. Collapsing a missing path to its ancestor instead is subtly wrong and
// was measured to be: <root>/shadow would resolve to <root>, and every sibling of it —
// including <root>/data — then tested as "inside the shadow store".
export function realPathOrNearest (p) {
  const abs = path.resolve(p)
  let cur = abs
  const tail = []
  for (;;) {
    try {
      const real = fs.realpathSync(cur)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {}
    const up = path.dirname(cur)
    if (up === cur) return abs // hit the root without finding anything that exists
    tail.push(path.basename(cur))
    cur = up
  }
}

export function isInside (parent, dir) {
  const rel = path.relative(realPathOrNearest(parent), realPathOrNearest(dir))
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

// The panel's signing keys. Read with plain fs rather than panel/src/keys.js openKeys() on
// purpose: openKeys() chmods keys/ and secrets/ as a side effect, and this tool must have no
// side effects on DATA_DIR outside the one directory rename it announces. It also keeps the
// tool independent of the panel's source layout when it is copied into the container.
function readSigningPublicKeyHex (dataDir) {
  const p = path.join(dataDir, 'keys', 'signing.json')
  must(fs.existsSync(p), `no signing key at ${p} — is --data-dir really the panel's DATA_DIR? ` +
    'It must be the directory that holds both keys/ and cores/ (panel/src/store.js openStore uses it as the corestore root).')
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  must(typeof j.publicKey === 'string' && /^[0-9a-f]{64}$/i.test(j.publicKey),
    `${p} has no usable 64-hex publicKey — refusing to guess which core is the panel bee.`)
  return j.publicKey.toLowerCase()
}

// Only `rebuild` needs the secret half. It is never logged, never written anywhere, and never
// passed to the dump.
function readSigningKeyPair (dataDir) {
  const p = path.join(dataDir, 'keys', 'signing.json')
  const pub = readSigningPublicKeyHex(dataDir)
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  must(typeof j.secretKey === 'string' && /^[0-9a-f]{128}$/i.test(j.secretKey),
    `${p} has no usable 128-hex secretKey — the rebuild must sign the new fork with the panel's own key, ` +
    'or clients would reject every block in it.')
  return { publicKey: b4a.from(pub, 'hex'), secretKey: b4a.from(j.secretKey, 'hex') }
}

// Opening the LIVE panel store must never be able to append. `{ key }` alone does NOT achieve
// that: the secret key is persisted in the core's own oplog header (the panel created it with
// `store.get({ keyPair })`), so a key-only session on the panel's store comes back
// `writable === true` — measured, not assumed. `writable: false` sets hypercore's `_readonly`
// (hypercore/index.js:88), which makes append() and truncate() throw SESSION_NOT_WRITABLE.
// That flag is the only structural guarantee here, so it is asserted immediately after.
async function openReadOnly (storeDir, publicKey) {
  const keyBuf = toKeyBuffer(publicKey)
  const store = new Corestore(storeDir)
  let core = null
  try {
    await store.ready()
    core = store.get({ key: keyBuf, writable: false })
    await core.ready()
  } catch (err) {
    try { await store.close() } catch {}
    // random-access-file takes an OS lock on every core file it opens and raises this when
    // someone else holds it (random-access-file/index.js createLockError). On a panel box there
    // is exactly one realistic explanation, and it is the single most likely first error an
    // operator will hit — so say it in those words rather than leaking `ELOCKED: File is locked`.
    if (err && err.code === 'ELOCKED') {
      throw new Error(`THE PANEL IS STILL RUNNING — ${storeDir} is locked by another process` +
        `${err.path ? ` (${err.path})` : ''}. Stop it and re-run:  docker compose stop panel\n` +
        'Every phase of this tool assumes no writer. Nothing has been changed.')
    }
    throw err
  }
  must(core.writable === false,
    `the core at ${storeDir} opened WRITABLE despite writable:false — refusing to touch it. ` +
    'This build of hypercore does not honour the read-only session flag; do not proceed, nothing here can promise it will not append.')
  must(b4a.equals(core.key, keyBuf),
    `the core opened at ${storeDir} has key ${b4a.toString(core.key, 'hex')} but ${b4a.toString(keyBuf, 'hex')} was requested — ` +
    'corestore returned a different core than asked for; stop and investigate.')
  return { store, core }
}

function coreShape (core) {
  return {
    keyHex: b4a.toString(core.key, 'hex'),
    discoveryKeyHex: b4a.toString(core.discoveryKey, 'hex'),
    fork: core.fork,
    length: core.length,
    byteLength: core.byteLength,
    contiguousLength: core.contiguousLength
  }
}

// core.info({ storage: true }) returns Buffers for key/discoveryKey which serialise as
// {type:'Buffer',data:[...]}; only the storage sub-object is wanted in the sidecar. Its
// `blocks` field is ALLOCATED bytes of `data` (st.blocks*512), which is what `df` sees — not
// the apparent size, which for a hole-punched core lies.
async function storageInfo (core) {
  const info = await core.info({ storage: true })
  return info.storage || null
}

// Before/after evidence that a phase did not write to the core it read. `data` is compared on
// size+mtime only (13.7 GB is not hashable); tree/bitfield/oplog are hashed, which is what
// makes the claim evidence rather than a filesystem-timestamp-granularity guess.
function readOnlyProof (coreDir) {
  const snap = () => {
    const s = statParts(coreDir)
    for (const f of CORE_FILES) {
      if (f === 'data') continue
      s.files[f] = s.files[f] ? { ...s.files[f], sha256: hashFileMaybe(path.join(coreDir, f)) } : null
    }
    return s
  }
  const before = snap()
  return {
    before,
    finish () {
      const after = snap()
      const same = (f) => JSON.stringify(before.files[f]) === JSON.stringify(after.files[f])
      const ev = { before, after, unchanged: {} }
      for (const f of CORE_FILES) ev.unchanged[f] = same(f)
      // data and tree carry the blocks and the signed merkle tree. If either moved, something
      // wrote to the core we were told to read, and every number produced is suspect.
      must(ev.unchanged.data,
        `the core's \`data\` file CHANGED during a read-only phase (${JSON.stringify(before.files.data)} -> ` +
        `${JSON.stringify(after.files.data)}). Something is writing to this store — the panel is probably still running. ` +
        'Stop it, discard anything this run produced, and start over: the dump may be a torn snapshot.')
      must(ev.unchanged.tree,
        `the core's \`tree\` file CHANGED during a read-only phase (${JSON.stringify(before.files.tree)} -> ` +
        `${JSON.stringify(after.files.tree)}). The signed merkle tree moved under us — a writer is active. Discard this run.`)
      must(ev.unchanged.bitfield,
        `the core's \`bitfield\` CHANGED during a read-only phase — a writer is active. Discard this run.`)
      // The oplog is hypercore's write-ahead log, and opening a core can legitimately rewrite
      // its 8 KiB header (slot rotation) without any block changing. In testing against these
      // exact versions it did NOT move for a writable:false session, so this is reported
      // rather than asserted: an oplog-only change is semantically inert, while making it
      // fatal would fail a phase that did nothing wrong.
      if (!ev.unchanged.oplog) warn('the oplog changed during a read-only phase (header rotation) — inert, but noted:',
        JSON.stringify(before.files.oplog), '->', JSON.stringify(after.files.oplog))
      return ev
    }
  }
}

// A witness over the WHOLE data directory, not just the four core files. The dump claims to
// be read-only; on a box that just came out of an ENOSPC outage that claim needs positive
// evidence covering everything the panel keeps, because the ways this tool could mutate
// DATA_DIR are not all inside cores/ — panel/src/keys.js openKeys(), for one, chmods keys/ and
// secrets/ merely by being called, which is exactly why this file reads signing.json with
// plain fs instead. `mode` is recorded alongside size+mtime for that reason: a chmod moves
// neither of the other two.
//
// Never reads file CONTENT — signing.json holds the panel's secret key and this evidence is
// printed and written to a sidecar.
// The sweep is FULLY RECURSIVE, every file under DATA_DIR. An earlier version stopped at the
// top level plus keys/ and secrets/, recording cores/ only as one directory entry — which made
// the four files of each of the panel's OTHER four cores (the assets and updates drives'
// metadata and blobs cores) invisible, so a corrupted oplog planted in one of them was
// reported clean. A panel DATA_DIR is ~40 files; there is no reason to sample it.
//
// DIR_CAP is a safety valve, not a policy: if this ever points somewhere enormous the witness
// reports that it is incomplete rather than silently covering a prefix, and the caller says so
// instead of claiming a clean sweep.
const WITNESS_FILE_CAP = 20000

function dataDirWitness (dataDir) {
  const root = path.resolve(dataDir)
  const seen = {}
  let truncated = false
  const note = (rel, p) => {
    try {
      const st = fs.lstatSync(p)
      seen[rel] = {
        type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file',
        size: st.isDirectory() ? null : st.size,
        mode: st.mode & 0o7777,
        mtimeMs: st.mtimeMs,
        // A directory's own mtime moves when entries are added or removed, but listing it as
        // well makes a create+delete that nets out visible too.
        entries: st.isDirectory() ? fs.readdirSync(p).sort() : undefined
      }
    } catch (err) { seen[rel] = { missing: err.code } }
  }
  const walk = (dir, rel) => {
    if (Object.keys(seen).length > WITNESS_FILE_CAP) { truncated = true; return }
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      note(r, p)
      // isDirectory() is false for a symlink to a directory (lstat semantics), so this never
      // follows a link out of DATA_DIR.
      if (e.isDirectory()) walk(p, r)
    }
  }
  note('.', root)
  walk(root, '')
  Object.defineProperty(seen, '__truncated', { value: truncated, enumerable: false })
  return seen
}

function diffWitness (before, after) {
  const moved = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      moved.push(`${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`)
    }
  }
  return moved
}

// =========================================================================================
// 1. DUMP
// =========================================================================================

// Reads every LIVE entry out of the panel bee and writes NDJSON, one {"k","v"} per line, both
// base64 of the RAW bytes.
//
// The encodings are `binary`/`binary` on purpose and it is the whole point of the format: the
// panel stores JSON values, and round-tripping them through JSON.parse/JSON.stringify would
// re-serialise every record — reordering object keys, renormalising number formatting,
// mangling anything non-UTF8. These records carry password verifiers and signed entitlement
// grants. A re-encode that changes one byte of one user's record is a silent, unrecoverable
// corruption that verify would happily bless. So nothing here ever parses a value.
//
// Note this reads ~6.5 MB, not 13.7 GB: createReadStream walks the B-tree and touches only
// the blocks that are still reachable. The dead weight is exactly what is never read.
export async function dumpBee ({ dataDir, publicKey, outPath, timestamp = null }) {
  must(dataDir && outPath, 'dumpBee needs { dataDir, outPath }')
  const keyHexWanted = b4a.toString(toKeyBuffer(publicKey || readSigningPublicKeyHex(dataDir)), 'hex')
  const coreDir = coreDirFor(dataDir, keyHexWanted)
  must(fs.existsSync(coreDir),
    `no core directory at ${coreDir} — the panel bee for key ${keyHexWanted} is not in this store. ` +
    'Check --data-dir, and check the key: this path is a pure function of the two.')
  must(!fs.existsSync(outPath),
    `${outPath} already exists — refusing to overwrite a dump. If the previous one is worthless, move it aside first; ` +
    'a dump is the only offline copy of the bee that will exist during the swap.')
  // The dump must not land inside DATA_DIR: it is the only offline copy of the database, so it
  // does not belong on the volume being compacted (nor anywhere the panel's start-time core GC
  // walks), and writing into DATA_DIR would also destroy this phase's own read-only evidence.
  must(!isInside(dataDir, outPath),
    `--out ${path.resolve(outPath)} is inside DATA_DIR ${path.resolve(dataDir)}. REFUSED: the dump is the only offline ` +
    'copy of the bee during the swap and must not live on the volume being compacted. Write it to a separate mount.')

  const witnessBefore = dataDirWitness(dataDir)
  const proof = readOnlyProof(coreDir)
  const { store, core } = await openReadOnly(dataDir, keyHexWanted)
  let result = null
  try {
    must(core.length > 0, `the core is EMPTY (length 0) at ${coreDir} — there is nothing to compact and nothing to dump.`)
    must(await Hyperbee.isHyperbee(core),
      `block 0 of ${coreDir} does not decode as a hyperbee header — this core is not the panel bee. Stop.`)
    // The stream would otherwise BLOCK FOREVER on a block no peer can serve: there is no swarm
    // here by design. A writer's own core is always contiguous, so a gap means the store is
    // damaged, and that is a different (and worse) problem than compaction.
    must(core.contiguousLength === core.length,
      `the core is not contiguous (contiguousLength ${core.contiguousLength} of length ${core.length}) — ` +
      `${core.length - core.contiguousLength} block(s) are missing locally. A dump would hang waiting for a peer. ` +
      'This store is damaged; do NOT compact it, restore from backup instead.')

    const lengthAtStart = core.length
    const forkAtStart = core.fork
    // Block 0 is the hyperbee header. It is not an entry, so createReadStream never yields it —
    // capture it here or `verify` has nothing to compare the rebuilt header against.
    const block0 = await core.get(0)

    const db = new Hyperbee(core, { keyEncoding: 'binary', valueEncoding: 'binary' })
    await db.ready()

    // 0o600: this file is every user record and every grant in the deployment, in the clear.
    // It is exactly as sensitive as the bee itself.
    const fd = fs.openSync(outPath, 'wx', 0o600)
    const hash = crypto.createHash('sha256')
    let keyCount = 0
    let payloadBytes = 0
    try {
      for await (const node of db.createReadStream()) {
        must(node.value !== null && node.value !== undefined,
          `entry ${JSON.stringify(b4a.toString(node.key, 'utf8'))} streamed with a null value — ` +
          'the bee is returning something this dump format cannot represent. Stop.')
        const line = b4a.from(JSON.stringify({
          k: b4a.toString(node.key, 'base64'),
          v: b4a.toString(node.value, 'base64')
        }) + '\n')
        // write(2) is allowed to write fewer bytes than asked. The sha re-check downstream
        // would eventually catch a short write, but only after the operator has built and
        // verified a shadow from a silently truncated dump — catch it at the byte instead.
        const wrote = fs.writeSync(fd, line)
        must(wrote === line.length,
          `short write to ${outPath}: asked for ${line.length} bytes, wrote ${wrote}. The dump is truncated ` +
          '(a full disk is the usual cause). Delete it and re-run once there is space.')
        hash.update(line)
        keyCount++
        payloadBytes += node.key.length + node.value.length
      }
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    const dirSync = fsyncDir(path.dirname(path.resolve(outPath)))

    // A bee whose blocks are all superseded deletions is a legitimate hypercore but a
    // catastrophic thing to rebuild from: the shadow would be an EMPTY panel — no accounts, no
    // catalog — and every downstream check would pass, because it would faithfully reproduce
    // nothing. There is no real panel state this is ever the right answer for.
    must(keyCount > 0,
      `the bee has ${core.length} block(s) but ZERO live entries. Refusing to dump: rebuilding from this would install an ` +
      'EMPTY database — no accounts, no catalog, no grants — and every later check would pass because it would be a ' +
      'faithful copy of nothing. Confirm you are pointed at the right core (`report --data-dir ...`) before going further.')
    // A concurrent writer is the one failure this phase cannot tolerate and cannot see any
    // other way — a bee that grew mid-stream yields a dump that is neither the old state nor
    // the new one.
    must(core.length === lengthAtStart,
      `the core GREW during the dump (length ${lengthAtStart} -> ${core.length}). The panel (or another writer) is ` +
      'STILL RUNNING. This dump is a torn snapshot: delete it, stop the writer, start over.')
    must(core.fork === forkAtStart,
      `the core's fork changed during the dump (${forkAtStart} -> ${core.fork}) — another process truncated it. Discard this dump.`)

    const dumpSha256 = hash.digest('hex')
    const shape = coreShape(core)
    const storage = await storageInfo(core)
    const evidence = proof.finish()
    // Positive proof that the dump touched NOTHING in DATA_DIR — not the core files, and not
    // keys/, secrets/, primary-key, sources.json, packages.json or anything else the panel
    // keeps beside them. Fatal, because the whole value of this phase is that it is safe to
    // run against irreplaceable live data.
    const witnessAfter = dataDirWitness(dataDir)
    const witnessMoved = diffWitness(witnessBefore, witnessAfter)
    must(witnessMoved.length === 0,
      `the dump MODIFIED ${witnessMoved.length} path(s) under ${path.resolve(dataDir)} — it is supposed to be read-only:\n  ` +
      witnessMoved.join('\n  ') + '\nEither another process is writing to DATA_DIR (is the panel still running?) or this ' +
      'tool has a side effect it should not have. Treat the dump as untrustworthy.')
    if (witnessAfter.__truncated) {
      warn(`the DATA_DIR sweep hit its ${WITNESS_FILE_CAP}-path cap — the read-only evidence covers a PREFIX of DATA_DIR,`,
        'not all of it. The core-file proof above is still complete.')
    }
    const meta = {
      tool: TOOL,
      phase: 'dump',
      at: timestamp || new Date().toISOString(),
      dataDir: path.resolve(dataDir),
      coreDir,
      dumpPath: path.resolve(outPath),
      keyCount,
      payloadBytes,
      dumpBytes: fs.statSync(outPath).size,
      dumpSha256,
      // Every downstream phase reads its expectations from here, so the shape is recorded in
      // full rather than re-derived.
      ...shape,
      storage,
      // The header block, verbatim. verify asserts the rebuilt core's block 0 against this.
      block0B64: b4a.toString(block0, 'base64'),
      block0Sha256: crypto.createHash('sha256').update(block0).digest('hex'),
      onDisk: evidence.after.files,
      readOnlyProof: evidence.unchanged,
      dataDirWitness: { paths: Object.keys(witnessAfter).length, moved: witnessMoved },
      dumpDirFsync: dirSync,
      // The ONLY value the next phase may be given for --fork. Printed here so the operator
      // never computes it in their head at 3am.
      rebuildAtFork: shape.fork + 1
    }
    // 'wx', exactly like the NDJSON. A plain 'w' here made the tool's own advice destructive:
    // the refusal above tells the operator to move bee.ndjson aside and re-dump, but a re-dump
    // that overwrote bee.ndjson.meta.json IN PLACE left the moved-aside dump permanently
    // unusable, because readDumpMeta needs the sidecar that was just clobbered. A dump and its
    // sidecar are one artefact; both are write-once.
    const metaPath = outPath + '.meta.json'
    const metaBody = b4a.from(JSON.stringify(meta, null, 2) + '\n')
    let mfd
    try {
      mfd = fs.openSync(metaPath, 'wx', 0o600)
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        throw new Error(`${metaPath} already exists but ${outPath} did not — refusing to overwrite it. ` +
          'A sidecar without its dump belongs to an EARLIER dump, and overwriting it would make that dump unreadable ' +
          `(readDumpMeta needs it). Move the pair aside together:  mv "${metaPath}" "${metaPath}.old"`)
      }
      throw err
    }
    try {
      const wroteMeta = fs.writeSync(mfd, metaBody)
      must(wroteMeta === metaBody.length,
        `short write to ${metaPath}: asked for ${metaBody.length} bytes, wrote ${wroteMeta}. The sidecar is truncated ` +
        'and the dump cannot be used without it. Delete both and re-run.')
      fs.fsyncSync(mfd)
    } finally { fs.closeSync(mfd) }
    fsyncDir(path.dirname(path.resolve(metaPath)))

    result = {
      ...shape,
      keyCount,
      dumpPath: meta.dumpPath,
      metaPath: path.resolve(metaPath),
      dumpSha256,
      storage,
      readOnlyProof: evidence.unchanged,
      dataDirPathsWitnessed: Object.keys(witnessAfter).length,
      rebuildAtFork: meta.rebuildAtFork
    }
  } finally { await store.close() }
  return result
}

// =========================================================================================
// 2. SHADOW REBUILD
// =========================================================================================

export function readDumpMeta (dumpPath) {
  const metaPath = dumpPath + '.meta.json'
  must(fs.existsSync(metaPath),
    `no sidecar at ${metaPath} — a dump without its metadata cannot be verified against anything ` +
    '(no key, no fork, no checksum). Re-run `dump`.')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  must(meta && meta.tool === TOOL && typeof meta.keyHex === 'string' && Number.isInteger(meta.fork),
    `${metaPath} is not a ${TOOL} dump sidecar — refusing to act on it.`)
  return meta
}

// Replays the dump into a NEW core with the same keypair at `fork`.
export async function shadowRebuild ({ dumpPath, keyPair, storeDir, fork, dataDirHint = null }) {
  must(dumpPath && keyPair && storeDir, 'shadowRebuild needs { dumpPath, keyPair, storeDir, fork }')
  must(Number.isInteger(fork) && fork > 0,
    `fork must be a positive integer, got ${JSON.stringify(fork)}. It is never defaulted here — the caller computes it, ` +
    'because getting it wrong is the one mistake in this tool that cannot be undone from the client side.')

  const meta = readDumpMeta(dumpPath)
  // THE assertion. Rebuilding at the SAME fork is the catastrophic case: hypercore's
  // checkConflict (lib/core.js:841-843) short-circuits on a fork MISMATCH, so a matching fork
  // with different block content is a real conflict and every connected client calls
  // _closeAllSessions — they do not recover, they do not re-sync, they break.
  must(fork === meta.fork + 1,
    `refusing to rebuild at fork ${fork}: the dumped core is at fork ${meta.fork}, so the only safe value is ${meta.fork + 1}. ` +
    (fork === meta.fork
      ? 'You asked for the SAME fork. That is the catastrophic case — clients would see a conflicting block at a sequence '
        + 'number they already hold, hypercore would call _closeAllSessions, and every viewer session would break unrecoverably.'
      : 'Skipping forks is not safe either: the fork counter is a signed field and the client-side recovery path expects the successor.'))

  // The dump is the only copy of the live state at this point. Prove it is intact before
  // building anything out of it.
  const actualSha = sha256File(dumpPath)
  must(actualSha === meta.dumpSha256,
    `dump checksum MISMATCH at ${dumpPath}: sidecar says ${meta.dumpSha256}, file hashes ${actualSha}. ` +
    'The dump was truncated or altered after it was written. Do NOT rebuild from it — re-run `dump` from the live core.')

  const keyHex = b4a.toString(keyPair.publicKey, 'hex')
  must(keyHex === meta.keyHex,
    `keypair mismatch: this keypair is for ${keyHex} but the dump came from ${meta.keyHex}. ` +
    'A core rebuilt under the wrong key is a different database to every client. Check --data-dir.')

  // Refuse to append onto a half-built shadow. Re-running after a failure must start from
  // nothing, or a partial batch from the previous attempt silently rides along.
  const resolvedStore = path.resolve(storeDir)
  if (fs.existsSync(resolvedStore)) {
    const ents = fs.readdirSync(resolvedStore)
    must(ents.length === 0,
      `shadow store ${resolvedStore} is not empty (${ents.join(', ')}) — refusing to build into it. ` +
      `A previous attempt may have left a partial core there, and appending onto it would produce a bee that is neither ` +
      `the old state nor the new one. Remove it and re-run:  rm -rf "${resolvedStore}"`)
  }
  must(!fs.existsSync(coreDirFor(resolvedStore, keyHex)),
    `the shadow store already holds this core at ${coreDirFor(resolvedStore, keyHex)} — refusing to append onto it.`)
  // A shadow store inside DATA_DIR would put a second copy of the bee on the volume being
  // compacted, and a --store pointed AT DATA_DIR would try to build over the live core itself.
  must(dataDirHint === null || !isInside(dataDirHint, resolvedStore), () =>
    `--store ${resolvedStore} is inside DATA_DIR ${path.resolve(dataDirHint)}. Build the shadow on a different mount: ` +
    'it does not belong on the volume being compacted, and a --store that resolves onto the live store would be ' +
    'building over the database itself.')

  const store = new Corestore(resolvedStore)
  await store.ready()
  let out = null
  try {
    const core = store.get({ keyPair })
    await core.ready()
    must(core.length === 0 && core.fork === 0,
      `the freshly opened shadow core is not blank (length ${core.length}, fork ${core.fork}) — expected 0/0. ` +
      'Something already wrote here. Delete the shadow store and start again.')
    must(b4a.equals(core.key, keyPair.publicKey), 'the shadow core did not take the panel key — corestore returned the wrong core.')

    // No signature needed: hypercore/lib/core.js only signs a truncate batch when length > 0.
    // This is what stamps the new fork onto the tree before a single block exists, so every
    // block appended below is signed at fork N from the start.
    await core.truncate(0, { fork })
    must(core.length === 0,
      `after truncate(0, {fork:${fork}}) the core has length ${core.length} — expected 0. Do not continue.`)
    must(core.fork === fork && core.core.tree.fork === fork,
      `after truncate the fork is ${core.fork} (tree.fork ${core.core.tree.fork}), expected ${fork}. ` +
      'The rebuild would be signed at the wrong fork; every client would treat it as a conflict. Stop.')

    const db = new Hyperbee(core, { keyEncoding: 'binary', valueEncoding: 'binary' })
    await db.ready()

    // ONE batch. hyperbee's Batch buffers every put and flush() emits them through a single
    // core.append(array) (hyperbee/index.js `flush` -> `_appendBatch`), which hypercore commits
    // as one oplog entry — so the entries land all-or-nothing. (Measured: the batch costs
    // exactly two appends — the 10-byte header block, written on the first put by
    // getRoot(true), then the single array of every node. A crash between them leaves a valid
    // EMPTY bee, which is indistinguishable from "the rebuild never ran" and is why the header
    // being separate is harmless.)
    const batch = db.batch()
    let keyCount = 0
    const rl = readline.createInterface({ input: fs.createReadStream(dumpPath), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line) continue
      const rec = JSON.parse(line)
      await batch.put(b4a.from(rec.k, 'base64'), b4a.from(rec.v, 'base64'))
      keyCount++
    }
    await batch.flush()

    must(keyCount === meta.keyCount,
      `replayed ${keyCount} entries but the sidecar recorded ${meta.keyCount} — the dump file does not match its metadata. ` +
      'Discard the shadow and re-run `dump`.')
    // header + exactly one block per put. This catches a batch that did not append what it was
    // handed; it does NOT catch duplicate keys — hyperbee appends one block per `put`
    // regardless of whether the key already exists, so a dump containing the same key twice
    // yields length === keyCount + 1 and passes here. `verify` is the only thing that catches
    // that, via the lockstep multiset comparison against the dump (and, with --data-dir,
    // against the live bee).
    must(core.length === keyCount + 1,
      `the rebuilt core has length ${core.length}, expected ${keyCount + 1} (one header block + one node per key). ` +
      'Either the dump contained duplicate keys or the batch did not append what it was given. Discard the shadow.')
    must(core.fork === fork, `the rebuilt core drifted to fork ${core.fork}, expected ${fork}. Discard the shadow.`)
    must(b4a.toString(core.key, 'hex') === meta.keyHex,
      `the rebuilt core's key is ${b4a.toString(core.key, 'hex')}, expected ${meta.keyHex}. Discard the shadow.`)

    // Push the merkle tree out of the write-ahead log and into `tree`, so the core we hand the
    // panel has the same on-disk shape as any other core rather than ~2,700 unflushed oplog
    // entries. hypercore does this itself every 4th append or once the oplog passes
    // _maxOplogSize (65,536) — this rebuild makes only two appends, so at small sizes it never
    // fires. Measured, on a 500-key rebuild: tree 40 B -> 40,040 B, oplog 45,599 B -> 8,192 B.
    // Best-effort: the unflushed state is fully durable either way (hypercore replays the
    // oplog on open, and the panel's first write flushes it), so failing here is not a reason
    // to discard a good rebuild — and `verify` reopens in a fresh process afterwards regardless.
    let oplogFlushed = false
    try {
      if (typeof core.core._flushOplog === 'function') { await core.core._flushOplog(); oplogFlushed = true }
    } catch (err) { warn('could not flush the oplog into tree/bitfield:', err.message, '— harmless, hypercore will replay it on open') }

    const shape = coreShape(core)
    out = { ...shape, keyCount, coreDir: coreDirFor(resolvedStore, meta.keyHex), storeDir: resolvedStore, oplogFlushed, storage: await storageInfo(core) }
  } finally { await store.close() }

  out.onDisk = statParts(out.coreDir).files
  fsyncDir(out.coreDir)
  return out
}

// =========================================================================================
// 3. VERIFY  — the gate. Run it as its own process; nothing here may come from a warm cache.
// =========================================================================================

// INSIDE the store directory, not beside it. A receipt at <store>.verify-receipt.json outlives
// its store: `rm -rf <store>` — which this tool's own rebuild refusal tells the operator to run
// — leaves the receipt behind, and a second rebuild from a DIFFERENT dump then inherits the
// blessing of the first. The receipt must die with the thing it blesses.
export function receiptPathFor (storeDir) {
  return path.join(path.resolve(storeDir), 'verify-receipt.json')
}

// A cryptographic commitment to the shadow's CONTENT, not merely its shape.
//
// fork/length/byteLength are all deterministic functions of the dump, so a receipt that binds
// only those blesses ANY rebuild of the same size — including one built from a different dump
// with a user record edited byte-for-byte (`"status":"active"` -> `"status":"BANNED"` is
// 184 B for 184 B). treeHash is the merkle root: it commits to every block. The `data` and
// `tree` file digests are recorded alongside it so a swap can also prove the bytes on disk are
// the ones that were verified, not just that a core with the same root could be rebuilt.
async function shadowFingerprint (core, coreDir) {
  const th = await core.treeHash()
  return {
    treeHash: b4a.toString(th, 'hex'),
    treeFileSha256: hashFileMaybe(path.join(coreDir, 'tree')),
    dataFileSha256: hashFileMaybe(path.join(coreDir, 'data'))
  }
}

export async function verifyShadow ({ dumpPath, storeDir, expect, dataDir = null, liveCompare = true }) {
  must(dumpPath && storeDir, 'verifyShadow needs { dumpPath, storeDir, expect }')
  // The dump leg alone cannot detect a SHORT dump. keyCount and dumpSha256 are both computed
  // inside the same loop that writes the file, so they agree with it by construction: drop
  // three entries and the dump, its sidecar and the shadow built from it are perfectly
  // self-consistent. The only independent authority on what the panel's state IS, is the live
  // bee. So the live comparison is the default and skipping it takes an explicit flag.
  must(liveCompare === false || dataDir,
    'verifyShadow needs dataDir to compare the shadow against the LIVE bee. Verifying against the dump alone cannot ' +
    'detect a dump that was short to begin with — the dump\'s own key count and checksum are derived from the same ' +
    'pass that wrote it, so they can never disagree with it. Pass dataDir (CLI: --data-dir), or pass ' +
    'liveCompare:false (CLI: --no-live-compare) to accept that gap deliberately — `swap` will then refuse the receipt.')
  const meta = readDumpMeta(dumpPath)
  const expectedFork = expect && expect.fork !== undefined ? expect.fork : null
  must(Number.isInteger(expectedFork),
    `verifyShadow needs expect.fork (an integer). For this dump the only correct value is ${meta.fork + 1}.`)
  must(expectedFork === meta.fork + 1,
    `expect.fork is ${expectedFork} but the dump is at fork ${meta.fork}, so the rebuild must be at ${meta.fork + 1}. ` +
    'Refusing to bless a core at any other fork — see the fork+1 rule at the top of this file.')
  const expectedKeyHex = (expect && expect.keyHex) || meta.keyHex

  const checks = []
  const pass = (name, detail) => { checks.push({ name, ok: true, detail }); log(`  ok  ${name}${detail ? ' — ' + detail : ''}`) }

  // Re-hash the dump: everything below is measured against it, so it has to be the same file
  // the rebuild consumed.
  const actualSha = sha256File(dumpPath)
  must(actualSha === meta.dumpSha256,
    `dump checksum MISMATCH: sidecar ${meta.dumpSha256}, file ${actualSha}. The dump changed since it was written; ` +
    'nothing verified against it means anything. Re-run `dump`.')
  pass('dump matches its recorded sha256', meta.dumpSha256.slice(0, 16) + '…')

  const coreDir = coreDirFor(storeDir, expectedKeyHex)
  must(fs.existsSync(coreDir), `no shadow core at ${coreDir} — nothing to verify. Did \`rebuild\` run against this --store?`)
  const proof = readOnlyProof(coreDir)
  const { store, core } = await openReadOnly(storeDir, expectedKeyHex)
  let out = null
  try {
    // --- 1. identity -----------------------------------------------------------------------
    const keyHex = b4a.toString(core.key, 'hex')
    const discoveryKeyHex = b4a.toString(core.discoveryKey, 'hex')
    must(keyHex === meta.keyHex,
      `the shadow core's key is ${keyHex}, the dump came from ${meta.keyHex}. This is a DIFFERENT database — do not swap it in.`)
    must(discoveryKeyHex === meta.discoveryKeyHex,
      `discovery key ${discoveryKeyHex} != ${meta.discoveryKeyHex}. The swap targets a path derived from this; do not proceed.`)
    pass('key and discovery key match the dump', keyHex.slice(0, 16) + '…')

    // --- 2. fork ---------------------------------------------------------------------------
    must(core.fork === expectedFork,
      `the shadow core is at fork ${core.fork}, expected ${expectedFork} (dump fork ${meta.fork} + 1). ` +
      (core.fork === meta.fork
        ? 'It is at the SAME fork as the live core — swapping this in would break every connected client unrecoverably. DO NOT SWAP.'
        : 'Rebuild it at the right fork before swapping.'))
    pass('fork is dumpFork+1', `${meta.fork} -> ${core.fork}`)

    // --- 3. it is still a hyperbee ---------------------------------------------------------
    must(await Hyperbee.isHyperbee(core),
      'block 0 of the shadow core does not decode as a hyperbee header — the panel would not recognise this core at all.')
    pass('Hyperbee.isHyperbee', 'block 0 decodes as a hyperbee header')

    // --- 4+5. every key present, byte-identical, and NO EXTRAS ------------------------------
    // Lockstep over both sorted streams: the dump is in createReadStream order and the rebuilt
    // bee streams in the same order, so one pass proves the key MULTISETS are equal (a
    // present-only check would bless a bee that gained keys) and that every value is
    // byte-identical, in O(1) memory. Values are compared as raw bytes — never parsed — for
    // the same reason the dump never parses them.
    const db = new Hyperbee(core, { keyEncoding: 'binary', valueEncoding: 'binary' })
    await db.ready()
    const beeIter = db.createReadStream()[Symbol.asyncIterator]()
    const rl = readline.createInterface({ input: fs.createReadStream(dumpPath), crlfDelay: Infinity })
    let n = 0
    let firstCatalogKey = null
    let firstUserKey = null
    let payloadBytes = 0
    for await (const line of rl) {
      if (!line) continue
      const rec = JSON.parse(line)
      const wantK = b4a.from(rec.k, 'base64')
      const wantV = b4a.from(rec.v, 'base64')
      const step = await beeIter.next()
      must(!step.done,
        `the rebuilt bee ran out of entries after ${n} — the dump has at least ${n + 1}. ` +
        `MISSING key ${JSON.stringify(b4a.toString(wantK, 'utf8'))}. The rebuild lost data; DO NOT SWAP.`)
      const got = step.value
      must(b4a.equals(got.key, wantK),
        `entry ${n} diverges: rebuilt bee has ${JSON.stringify(b4a.toString(got.key, 'utf8'))}, dump has ` +
        `${JSON.stringify(b4a.toString(wantK, 'utf8'))}. Both streams are sorted, so this is an inserted or dropped key, ` +
        'not a reordering. DO NOT SWAP.')
      must(b4a.equals(got.value, wantV),
        `value for ${JSON.stringify(b4a.toString(wantK, 'utf8'))} is NOT byte-identical ` +
        `(${wantV.length} B dumped, ${got.value.length} B rebuilt). This record — a user credential, a signed grant or a ` +
        'catalog entry — was altered by the rebuild. DO NOT SWAP.')
      n++
      payloadBytes += wantK.length + wantV.length
      const ks = b4a.toString(wantK, 'utf8')
      if (firstCatalogKey === null && ks.startsWith('catalog/')) firstCatalogKey = ks
      if (firstUserKey === null && ks.startsWith('user/')) firstUserKey = ks
    }
    // Lazy message: on the PASSING path `tail.value` is null, so this must not be built inline.
    const tail = await beeIter.next()
    must(tail.done && !tail.value, () =>
      `the rebuilt bee has EXTRA entries the dump does not: first is ` +
      `${JSON.stringify(tail.value ? b4a.toString(tail.value.key, 'utf8') : '(unknown)')}. ` +
      'The shadow was built from something other than this dump (or built twice). DO NOT SWAP.')
    must(n === meta.keyCount,
      `compared ${n} entries but the sidecar recorded ${meta.keyCount} — the dump file and its metadata disagree. DO NOT SWAP.`)
    pass('every key present and byte-identical', `${n} entries, raw-byte compared`)
    pass('no extra keys', 'the rebuilt key multiset equals the dump exactly')
    must(core.length === n + 1,
      `the shadow core has ${core.length} blocks for ${n} entries, expected ${n + 1} (header + one node per key). ` +
      'There are blocks in this core that the bee does not reach. DO NOT SWAP.')
    pass('no unreachable blocks', `length ${core.length} = ${n} entries + 1 header`)

    // --- 6. the PANEL's own encodings still read it -----------------------------------------
    // Everything above is a bytes-in-bytes-out proof. This is the different question: can the
    // process that has to live with this core actually use it? Same core, panel encodings
    // (panel/src/store.js openStore), real records.
    const panelDb = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await panelDb.ready()
    must(firstCatalogKey,
      'the bee contains no `catalog/` key. This does not look like a panel bee — refusing to bless it as one.')
    must(firstUserKey,
      'the bee contains no `user/` key. A panel bee with no accounts would lock everyone out — refusing to bless it.')
    const cat = await panelDb.get(firstCatalogKey)
    must(cat && cat.value && typeof cat.value === 'object',
      `${firstCatalogKey} does not parse as a JSON object through the panel's own encodings — the panel could not read this core.`)
    const usr = await panelDb.get(firstUserKey)
    must(usr && usr.value && typeof usr.value === 'object',
      `${firstUserKey} does not parse as a JSON object through the panel's own encodings — logins would fail against this core.`)
    for (const mk of ['meta/assetsKey', 'meta/updatesKey']) {
      const node = await panelDb.get(mk)
      must(node && node.value && typeof node.value === 'object',
        `${mk} is missing or unparseable. Clients discover the art / OTA drives through it; a core without it ` +
        'would make every poster and every app update undiscoverable. DO NOT SWAP.')
      must(typeof node.value.key === 'string' && typeof node.value.blobsKey === 'string',
        `${mk} lost its key/blobsKey fields (got ${JSON.stringify(node.value)}). A keyless repeater mirrors blobs through ` +
        'blobsKey; this record must survive the rebuild verbatim. DO NOT SWAP.')
    }
    pass('the panel\'s own encodings read it', `${firstCatalogKey}, ${firstUserKey}, meta/assetsKey, meta/updatesKey all parse`)

    // --- 7. size sanity ---------------------------------------------------------------------
    const ratio = payloadBytes > 0 ? core.byteLength / payloadBytes : 0
    const sizeNote = `byteLength ${core.byteLength} vs ${payloadBytes} B of key+value payload (x${ratio.toFixed(3)})`
    if (ratio < 0.9 || ratio > 2.5) {
      // Flagged, not fatal: hyperbee framing overhead is normally a few per cent, but the ratio
      // is a heuristic and the byte-for-byte checks above are the real proof.
      warn('byteLength is far from the dumped payload —', sizeNote,
        '— worth understanding before swapping, but the per-entry byte comparison above already passed.')
      checks.push({ name: 'byteLength within a sane bound of the payload', ok: false, flagged: true, detail: sizeNote })
    } else pass('byteLength within a sane bound of the payload', sizeNote)

    // --- 8. block 0 ---------------------------------------------------------------------------
    // Empirically determined against hypercore 10.38.2 / hyperbee 2.27.3: IDENTICAL, and
    // necessarily so. hyperbee writes the header as Header.encode({protocol:'hyperbee',
    // metadata: this.tree.metadata}) (index.js getRoot), the Header protobuf carries only
    // `protocol` and an optional `metadata`, and the panel passes no metadata — so the block is
    // the constant 10 bytes 0a 08 "hyperbee". Critically it carries NO encoding information,
    // which is what makes it legitimate to rebuild through a binary/binary bee a core that the
    // panel will reopen as utf-8/json. Asserted rather than assumed, because block 0 is what
    // Hyperbee.isHyperbee and every cold client key off.
    const block0 = await core.get(0)
    const want0 = b4a.from(meta.block0B64, 'base64')
    must(b4a.equals(block0, want0),
      `block 0 (the hyperbee header) DIFFERS from the live core's: live ${b4a.toString(want0, 'hex')} ` +
      `(${want0.length} B), rebuilt ${b4a.toString(block0, 'hex')} (${block0.length} B). Every cold client keys off this ` +
      'block. Do not swap until you understand the difference.')
    pass('block 0 is byte-identical to the live core\'s header', `${block0.length} B, ${b4a.toString(block0, 'hex')}`)

    // --- 9. the LIVE bee, compared directly, with the dump out of the loop -------------------
    // Everything above answers "does the shadow equal the dump". This answers the question the
    // operator actually has: does the shadow equal the DATABASE. They are not the same question
    // — a dump that was short, stale, or hand-edited satisfies the first and fails this one.
    //
    // Measured at ~2 s against the real 13.7 GB core, because the walk only touches live blocks.
    // There is no reason to skip it, and skipping it is recorded in the receipt so `swap` can
    // refuse.
    let live = null
    if (liveCompare) {
      const liveCoreDir = coreDirFor(dataDir, expectedKeyHex)
      must(fs.existsSync(liveCoreDir),
        `no live core at ${liveCoreDir} — --data-dir does not point at a store holding this bee. ` +
        'Check the path, or pass --no-live-compare if you genuinely mean to verify against the dump alone.')
      const liveProof = readOnlyProof(liveCoreDir)
      // Opening this ELOCKs if the panel is up, which is a second gate on the same mistake.
      const { store: lStore, core: lCore } = await openReadOnly(dataDir, expectedKeyHex)
      try {
        // The live core must still be the one that was dumped. If it has moved on, the rebuild
        // is stale by definition and everything downstream is measuring the wrong thing.
        must(lCore.fork === meta.fork && lCore.length === meta.length && lCore.byteLength === meta.byteLength,
          `THE LIVE CORE HAS MOVED SINCE THE DUMP: it is now fork ${lCore.fork}, length ${lCore.length}, ` +
          `byteLength ${lCore.byteLength}; the dump was taken at fork ${meta.fork}, length ${meta.length}, ` +
          `byteLength ${meta.byteLength}. The panel writes on every start (openStore) and continuously (liveness), so ` +
          'any uptime between the phases does this. Swapping now would silently DISCARD every write since the dump. ' +
          'Re-run the whole sequence: dump -> rebuild -> verify.')
        const liveDb = new Hyperbee(lCore, { keyEncoding: 'binary', valueEncoding: 'binary' })
        await liveDb.ready()
        const shadowDb = new Hyperbee(core, { keyEncoding: 'binary', valueEncoding: 'binary' })
        await shadowDb.ready()
        // Same lockstep shape as the dump comparison, over the two bees directly.
        const li = liveDb.createReadStream()[Symbol.asyncIterator]()
        const si = shadowDb.createReadStream()[Symbol.asyncIterator]()
        let m = 0
        for (;;) {
          const [a, b] = [await li.next(), await si.next()]
          if (a.done && b.done) break
          must(!a.done, () => `the shadow has an entry the LIVE bee does not: ` +
            `${JSON.stringify(b.value ? b4a.toString(b.value.key, 'utf8') : '?')} (after ${m} matching). DO NOT SWAP.`)
          must(!b.done, () => `the shadow is MISSING a key the live bee has: ` +
            `${JSON.stringify(a.value ? b4a.toString(a.value.key, 'utf8') : '?')} (after ${m} matching). ` +
            'Either the dump was short or the live bee has been written to since. DO NOT SWAP.')
          must(b4a.equals(a.value.key, b.value.key), () =>
            `live/shadow diverge at entry ${m}: live has ${JSON.stringify(b4a.toString(a.value.key, 'utf8'))}, ` +
            `shadow has ${JSON.stringify(b4a.toString(b.value.key, 'utf8'))}. Both streams are sorted, so this is an ` +
            'inserted or dropped key. DO NOT SWAP.')
          must(b4a.equals(a.value.value, b.value.value), () =>
            `the value for ${JSON.stringify(b4a.toString(a.value.key, 'utf8'))} differs from the LIVE bee ` +
            `(${a.value.value.length} B live, ${b.value.value.length} B shadow). The shadow was built from something ` +
            'that is not the current database. DO NOT SWAP.')
          m++
        }
        must(m === n,
          `walked ${m} live entries but ${n} in the shadow — counts disagree after a lockstep pass, which should be ` +
          'impossible. DO NOT SWAP.')
        live = { fork: lCore.fork, length: lCore.length, byteLength: lCore.byteLength, keyCount: m, coreDir: liveCoreDir }
      } finally { await lStore.close() }
      liveProof.finish() // the live compare must not have written to the live core either
      pass('the shadow matches the LIVE bee key-for-key', `${live.keyCount} entries compared directly, dump not involved`)
    } else {
      warn('LIVE COMPARE SKIPPED (--no-live-compare). This verification cannot detect a dump that was short or stale.',
        '`swap` will refuse this receipt.')
      checks.push({ name: 'the shadow matches the LIVE bee key-for-key', ok: false, skipped: true, detail: 'skipped by --no-live-compare' })
    }

    const shape = coreShape(core)
    const storage = await storageInfo(core)
    const fingerprint = await shadowFingerprint(core, coreDir)
    const evidence = proof.finish()
    out = {
      ok: true,
      checks,
      ...shape,
      keyCount: n,
      payloadBytes,
      storage,
      onDisk: evidence.after.files,
      readOnlyProof: evidence.unchanged,
      coreDir,
      dumpSha256: meta.dumpSha256,
      liveCompare: !!liveCompare,
      live,
      fingerprint
    }
  } finally { await store.close() }

  // The receipt is what `swap` demands. It exists so the verification cannot be something that
  // happened in the same process as the writing — swap re-reads it off disk and re-checks it
  // against the shadow core as it finds it.
  const receipt = {
    tool: TOOL,
    phase: 'verify',
    at: new Date().toISOString(),
    pid: process.pid,
    dumpPath: path.resolve(dumpPath),
    dumpSha256: out.dumpSha256,
    storeDir: path.resolve(storeDir),
    coreDir: out.coreDir,
    keyHex: out.keyHex,
    discoveryKeyHex: out.discoveryKeyHex,
    fork: out.fork,
    length: out.length,
    keyCount: out.keyCount,
    byteLength: out.byteLength,
    // Content, not shape — see shadowFingerprint. This is what makes the receipt un-transferable
    // to a different rebuild of the same size.
    fingerprint: out.fingerprint,
    // Whether the shadow was ever compared to the actual database, and what the database looked
    // like when it was. `swap` refuses a receipt where this is false.
    liveCompare: out.liveCompare,
    live: out.live,
    checks: out.checks.map((c) => ({ name: c.name, ok: c.ok, flagged: !!c.flagged, skipped: !!c.skipped }))
  }
  const rp = receiptPathFor(storeDir)
  const rBody = b4a.from(JSON.stringify(receipt, null, 2) + '\n')
  const rfd = fs.openSync(rp, 'w', 0o600)
  try {
    const wroteR = fs.writeSync(rfd, rBody)
    must(wroteR === rBody.length, `short write to ${rp}: ${wroteR} of ${rBody.length} bytes. Re-run verify.`)
    fs.fsyncSync(rfd)
  } finally { fs.closeSync(rfd) }
  fsyncDir(path.dirname(rp))
  out.receiptPath = rp
  return out
}

// =========================================================================================
// 4. SWAP
// =========================================================================================

// The intent journal. Written BEFORE the first rename, removed after the second.
//
// Between the two renames the panel's core path does not exist. A Ctrl-C, a dropped ssh, an
// OOM kill or a power cut in that window used to leave no record anywhere of what was in
// flight or where the 13.7 GB went — and the next `docker compose up -d` (which happens by
// habit, or by `restart: unless-stopped` with no human involved at all) would have openStore's
// `store.get({ keyPair })` create a BRAND NEW core at that path: same public key, fork 0,
// three blocks, zero users. That is precisely the same-key-different-blocks conflict this whole
// design exists to avoid, arrived at by crashing rather than by swapping. It also blocks the
// `mv` rollback, because the path is now taken.
export function intentPathFor (rollbackDir) {
  return path.join(path.resolve(rollbackDir), 'SWAP-IN-PROGRESS.json')
}

function findIntent (rollbackDir) {
  const p = intentPathFor(rollbackDir)
  if (!fs.existsSync(p)) return null
  try { return { path: p, intent: JSON.parse(fs.readFileSync(p, 'utf8')) } } catch { return { path: p, intent: null } }
}

export async function swapCore ({ dataDir, shadowStoreDir, rollbackDir, confirm }) {
  must(confirm === true,
    'swapCore requires confirm:true (CLI: --i-have-stopped-the-panel). This moves the live database out from under ' +
    'the panel; a running panel would keep writing to a core directory that is no longer at the path it opened.')
  must(dataDir && shadowStoreDir && rollbackDir, 'swapCore needs { dataDir, shadowStoreDir, rollbackDir, confirm }')

  const liveDir = path.resolve(dataDir)
  const shadowDir = path.resolve(shadowStoreDir)
  const rollDir = path.resolve(rollbackDir)

  // Transposing --data-dir and --shadow-store used to reach the renames. They are different
  // things and one cannot be the other.
  must(liveDir !== shadowDir,
    `--data-dir and --shadow-store are the same path (${liveDir}). They are different stores: one holds the live ` +
    'database, the other the compacted rebuild. Check the argument order.')
  must(!isInside(shadowDir, liveDir),
    `DATA_DIR ${liveDir} is inside the shadow store ${shadowDir} — the arguments look transposed. STOP.`)

  // --- the rollback must be OUTSIDE DATA_DIR ------------------------------------------------
  // Checked HERE, with the other pure argument validation, rather than after the receipt: a
  // wrong --rollback-dir is a wrong invocation, and the operator should not have to build and
  // verify a whole shadow before being told so.
  //
  // Not a preference. panel/src/store.js reclaimStrayCores -> core/store-gc.js purgeStaleCores
  // rmSync's every 64-hex-named directory under <DATA_DIR>/cores/** that is not one of the five
  // cores the panel owns, on EVERY panel start. A 13.7 GB rollback parked in there is deleted
  // by the first boot after the swap — the one moment you might need it. isInside resolves
  // SYMLINKS, so a rollback path that merely points back inside DATA_DIR is caught too.
  must(!isInside(liveDir, rollDir),
    `rollbackDir ${rollDir} is inside DATA_DIR ${liveDir}` +
    (realPathOrNearest(rollDir) !== path.resolve(rollDir) ? ` (it resolves to ${realPathOrNearest(rollDir)})` : '') +
    ". REFUSED: the panel's start-time GC (panel/src/store.js reclaimStrayCores -> core/store-gc.js purgeStaleCores) " +
    'deletes every 64-hex core directory under DATA_DIR/cores that it does not own, so the pre-swap core would be ' +
    'destroyed by the next panel start — and there is no peer to restore it from. Point --rollback-dir at a path ' +
    `OUTSIDE DATA_DIR on the same filesystem, e.g. ${path.join(path.dirname(liveDir), 'panel-rollback')}`)

  // A half-finished swap must be found and reported, not silently swapped over the top of.
  const stale = findIntent(rollDir)
  must(!stale,
    () => `A PREVIOUS SWAP DID NOT FINISH. Found ${stale.path}:\n` +
      (stale.intent
        ? `  started      ${stale.intent.at} (pid ${stale.intent.pid})\n` +
          `  live core    ${stale.intent.liveCoreDir}\n` +
          `  moved to     ${stale.intent.dest}\n` +
          `  shadow       ${stale.intent.shadowCoreDir}\n\n` +
          'Finish it BY HAND before running anything else. If the live path is empty, the original is still intact at\n' +
          `the "moved to" path above and this puts it back:\n  mv "${stale.intent.dest}" "${stale.intent.liveCoreDir}"\n` +
          'If the panel has already started and created a new core at the live path, move that aside FIRST — do not\n' +
          'delete it until you have confirmed the rollback is the core you want. Then remove the intent file.'
        : '  (the file is unreadable — inspect it by hand)\n') +
      'Refusing to run: swapping again from here could overwrite the only copy of the database.')

  // --- the receipt: proof that verify ran, in some other process, against THIS shadow --------
  const rp = receiptPathFor(shadowDir)
  must(fs.existsSync(rp),
    `no verification receipt at ${rp} — refusing to swap an unverified core. Run:\n` +
    `  node ${SELF} verify --data-dir ${liveDir} --dump <dump> --store ${shadowDir} --fork <n>`)
  const receipt = JSON.parse(fs.readFileSync(rp, 'utf8'))
  must(receipt && receipt.tool === TOOL && receipt.phase === 'verify', `${rp} is not a ${TOOL} verify receipt.`)
  must(path.resolve(receipt.storeDir) === shadowDir,
    `the receipt at ${rp} was written for ${receipt.storeDir}, not ${shadowDir}. Verify the store you are about to swap in.`)
  // A receipt from a --no-live-compare run proves only that the shadow equals the dump, which
  // says nothing about whether the dump equals the database.
  must(receipt.liveCompare === true,
    `the receipt at ${rp} was issued WITHOUT the live comparison (--no-live-compare). It proves the shadow matches the ` +
    'dump, not that it matches the database — a dump that was short or stale would pass it. Re-run verify with ' +
    '--data-dir before swapping.')

  // --- read the shadow as it is on disk RIGHT NOW, and re-check the receipt against it -------
  // The receipt is a claim about a past state; this is the same store now. If anything touched
  // the shadow between verify and swap, they disagree here.
  //
  // Check the directory BEFORE opening the store: `store.get()` CREATES an empty core at that
  // path if none is there, so opening first would (a) write a phantom core into the shadow
  // store as a side effect of a read, and (b) report the true situation — most likely "the
  // swap has already run and the shadow has been moved away" — as a confusing fork mismatch
  // against a core this tool just invented. Measured, not theorised: a second swap attempt did
  // exactly that.
  const shadowCoreDirPre = coreDirFor(shadowDir, receipt.keyHex)
  must(fs.existsSync(shadowCoreDirPre),
    `no core directory at ${shadowCoreDirPre}, but the receipt at ${rp} says one was verified there. ` +
    'The most likely explanation is that THE SWAP HAS ALREADY RUN and this core is now live — check ' +
    `${coreDirFor(liveDir, receipt.keyHex)} and the rollback directory before doing anything else. Do not re-run the ` +
    'swap blindly.')
  const { store: sStore, core: sCore } = await openReadOnly(shadowDir, receipt.keyHex)
  let shadow = null
  try {
    shadow = { ...coreShape(sCore), storage: await storageInfo(sCore), fingerprint: await shadowFingerprint(sCore, shadowCoreDirPre) }
  } finally { await sStore.close() }
  must(shadow.keyHex === receipt.keyHex,
    `the shadow core's key is now ${shadow.keyHex}, the receipt blessed ${receipt.keyHex}. Re-verify.`)
  must(shadow.fork === receipt.fork,
    `the shadow core is now at fork ${shadow.fork}, the receipt blessed fork ${receipt.fork}. Something rewrote it. Re-verify.`)
  must(shadow.length === receipt.length && shadow.byteLength === receipt.byteLength,
    `the shadow core changed since verification (length ${receipt.length}->${shadow.length}, ` +
    `byteLength ${receipt.byteLength}->${shadow.byteLength}). Re-run verify before swapping.`)
  // CONTENT, not shape. Shape alone is a function of the dump's size, so a receipt bound to it
  // transfers to any rebuild with the same number of equally-sized entries — including one
  // built from a re-dump with a user record edited byte-for-byte. The merkle root does not
  // transfer, and the file digests prove the bytes on disk are the verified ones.
  must(receipt.fingerprint && receipt.fingerprint.treeHash,
    `the receipt at ${rp} predates content binding (no fingerprint.treeHash). Re-run verify.`)
  must(shadow.fingerprint.treeHash === receipt.fingerprint.treeHash,
    `THE SHADOW CORE'S CONTENT DOES NOT MATCH THE RECEIPT. Merkle root is now ${shadow.fingerprint.treeHash}, the ` +
    `receipt blessed ${receipt.fingerprint.treeHash} (the shape matches, so this is a DIFFERENT rebuild of the same ` +
    'size — most likely the store was rebuilt from another dump after it was verified). Re-run verify.')
  for (const f of ['treeFileSha256', 'dataFileSha256']) {
    must(shadow.fingerprint[f] === receipt.fingerprint[f],
      `the shadow's \`${f.replace('Sha256', '')}\` file has changed since verification (${receipt.fingerprint[f]} -> ` +
      `${shadow.fingerprint[f]}). Re-run verify.`)
  }
  // A MISSING sidecar used to count as a pass here. It is the opposite: without it there is no
  // record of what was dumped, and every fork/length check below has nothing to measure against.
  must(fs.existsSync(receipt.dumpPath + '.meta.json'),
    `the dump sidecar ${receipt.dumpPath}.meta.json is GONE. The swap validates the live core against it; without it ` +
    'there is no way to confirm the core about to be replaced is the one that was dumped. Re-run dump -> rebuild -> verify.')
  const dumpMeta = readDumpMeta(receipt.dumpPath)
  must(dumpMeta.dumpSha256 === receipt.dumpSha256,
    `the dump sidecar at ${receipt.dumpPath}.meta.json no longer records the checksum the receipt was issued against ` +
    `(${receipt.dumpSha256} vs ${dumpMeta.dumpSha256}). The verification and the dump have diverged. Re-run verify.`)

  // --- the swap must target the SAME path in both stores ------------------------------------
  const disc = shadow.discoveryKeyHex
  const shadowCoreDir = coreDirFor(shadowDir, shadow.keyHex)
  const liveCoreDir = coreDirFor(liveDir, shadow.keyHex)
  must(path.relative(shadowDir, shadowCoreDir) === path.relative(liveDir, liveCoreDir),
    `the shadow core sits at a different relative path (${path.relative(shadowDir, shadowCoreDir)}) than the live one ` +
    `(${path.relative(liveDir, liveCoreDir)}). getStorageRoot should make these identical; if they are not, this build of ` +
    'corestore does not lay cores out the way this tool assumes. STOP.')
  must(fs.existsSync(shadowCoreDir), `no shadow core directory at ${shadowCoreDir}.`)
  must(fs.existsSync(liveCoreDir),
    `no live core directory at ${liveCoreDir} — there is nothing here to replace. Either --data-dir is wrong, or the swap ` +
    'has already run. Check the rollback directory before doing anything else.')
  must(path.basename(liveCoreDir) === disc,
    `the live core directory is named ${path.basename(liveCoreDir)} but the shadow's discovery key is ${disc} — ` +
    'these are different cores. STOP.')

  // --- OPEN THE LIVE CORE. Everything above measured the shadow against a SIDECAR; this is the
  // only thing that measures it against the core actually being replaced. -------------------
  //
  // Without this, three separate disasters are reachable by ordinary operator behaviour:
  //
  //   1. Re-running the runbook from a SAVED dump after a previous swap. The sidecar still says
  //      fork 0, so rebuild@1 and verify@1 both pass — and the live core is ALREADY at fork 1.
  //      Installing a second, different fork-1 core is the same-fork conflict: checkConflict
  //      matches on fork, the root hashes differ, and hypercore calls _closeAllSessions. Every
  //      client breaks unrecoverably. That is the exact outcome the top of this file claims the
  //      design prevents, and only this check prevents it.
  //   2. Any panel uptime between dump and swap. openStore writes on every start and liveness
  //      writes continuously, so the live core moves; swapping then silently discards every
  //      account and catalog change since the dump, with the output reading like a success.
  //   3. A panel that was never stopped at all. `dump` is protected by the OS lock every core
  //      file takes; a swap that opens nothing has no equivalent, and on Linux rename(2) on a
  //      directory with open files SUCCEEDS — the running panel's fds follow the inodes into the
  //      rollback directory and it keeps writing into a copy that vanishes on restart. Opening
  //      the core here takes the same lock, so a live panel surfaces as ELOCKED before anything
  //      moves. (It is a gate, not a mutex: the store is closed again before the renames, so a
  //      panel started in that window is still possible. The confirm flag covers intent; this
  //      covers the overwhelmingly more likely case of simply having forgotten.)
  const liveProof = readOnlyProof(liveCoreDir)
  const { store: lStore, core: lCore } = await openReadOnly(liveDir, receipt.keyHex)
  let liveNow = null
  try {
    liveNow = { ...coreShape(lCore), storage: await storageInfo(lCore) }
  } finally { await lStore.close() }
  liveProof.finish()

  must(liveNow.keyHex === receipt.keyHex,
    `the LIVE core's key is ${liveNow.keyHex} but the receipt blessed a rebuild of ${receipt.keyHex}. These are ` +
    'different databases. STOP.')
  // The core being replaced must be the core that was dumped — same fork, same length, same
  // bytes. Any drift means the rebuild is stale.
  must(liveNow.fork === dumpMeta.fork && liveNow.length === dumpMeta.length && liveNow.byteLength === dumpMeta.byteLength,
    `THE LIVE CORE IS NOT THE ONE THAT WAS DUMPED.\n` +
    `  live now:  fork ${liveNow.fork}, length ${liveNow.length}, byteLength ${liveNow.byteLength}\n` +
    `  dumped at: fork ${dumpMeta.fork}, length ${dumpMeta.length}, byteLength ${dumpMeta.byteLength}\n` +
    'The database has been written to since the dump was taken — the panel writes on every start (openStore) and ' +
    'continuously while it runs (liveness), and a previous swap moves the fork. Swapping now would either DISCARD ' +
    'every change since the dump, or install a second core at a fork the live one already occupies, which closes every ' +
    'client session unrecoverably.\nRe-run the whole sequence against the current state: dump -> rebuild -> verify -> swap.')
  // fork+1 computed from the LIVE core, never from the sidecar. This is the assertion that
  // actually enforces the rule the header states.
  must(shadow.fork === liveNow.fork + 1,
    `the compacted core is at fork ${shadow.fork} but the LIVE core is at fork ${liveNow.fork}, so the only safe value ` +
    `is ${liveNow.fork + 1}. ` +
    (shadow.fork === liveNow.fork
      ? 'They are at the SAME fork. Installing this would give clients a different block at a sequence number they ' +
        'already hold; hypercore treats that as a conflict and calls _closeAllSessions. DO NOT SWAP.'
      : 'Rebuild against a fresh dump of the current live core.'))

  fs.mkdirSync(rollDir, { recursive: true, mode: 0o700 })
  const dest = path.join(rollDir, disc)
  must(!fs.existsSync(dest),
    `${dest} already exists — refusing to overwrite a previous rollback. That directory may be the only copy of an ` +
    'earlier state of this database. Move it aside deliberately if you are sure.')

  // --- same filesystem: a rename, not a copy ------------------------------------------------
  // A cross-device rename fails with EXDEV, and a 13.7 GB copy is neither atomic nor free — on
  // a box that is already short of disk it would fail halfway with the live core half-moved.
  // st.dev is checked too, but the probe rename is the only thing that PROVES it: with the
  // usual two-mount container setup st.dev can agree while the rename still fails.
  //
  // The probe file is created in the ROLLBACK directory and renamed towards DATA_DIR and back,
  // never the other way round. An earlier version wrote it into <DATA_DIR>/cores/<a>/<b>/ and
  // would leave it there if killed mid-probe — litter inside the directory this tool promises
  // not to touch, in a tree whose 64-hex naming the panel's GC inspects.
  const devLive = fs.statSync(path.dirname(liveCoreDir)).dev
  const devRoll = fs.statSync(rollDir).dev
  const probeA = path.join(rollDir, `.${TOOL}-probe-${process.pid}`)
  const probeB = path.join(path.dirname(liveCoreDir), `.${TOOL}-probe-${process.pid}`)
  let renameOk = false
  try {
    fs.writeFileSync(probeA, 'probe', { mode: 0o600 })
    fs.renameSync(probeA, probeB)   // rollback -> DATA_DIR
    fs.renameSync(probeB, probeA)   // and straight back, so nothing is left behind either side
    renameOk = true
  } catch { renameOk = false } finally {
    for (const p of [probeA, probeB]) { try { fs.rmSync(p, { force: true }) } catch {} }
  }
  must(renameOk,
    `${rollDir} is not on the same filesystem as ${path.dirname(liveCoreDir)} (probe rename failed; st.dev ` +
    `${devLive} vs ${devRoll}). REFUSED: the move must be an instant, atomic rename. A cross-device move would copy ` +
    `${fmt(statParts(liveCoreDir).total)}, need that much free space, and leave the live core half-moved if it failed.\n` +
    'In a container this usually means --rollback-dir is a second bind mount rather than a path on the SAME mount as ' +
    'DATA_DIR. See the header comment on picking it.')

  const sizesBefore = { live: statParts(liveCoreDir), shadow: statParts(shadowCoreDir) }
  // Never rm anything: the undo is two renames and it never destroys either copy.
  const undo = `mv "${liveCoreDir}" "${path.join(rollDir, disc + '.compacted')}" && mv "${dest}" "${liveCoreDir}"`
  const recoverIfInterrupted = `mv "${dest}" "${liveCoreDir}"`

  // --- the intent journal, written BEFORE anything moves -------------------------------------
  const intentPath = intentPathFor(rollDir)
  const intent = {
    tool: TOOL,
    phase: 'swap-in-progress',
    at: new Date().toISOString(),
    pid: process.pid,
    dataDir: liveDir,
    liveCoreDir,
    dest,
    shadowCoreDir,
    discoveryKey: disc,
    // Both directions, spelled out, so a human who finds this file needs nothing else.
    recoverIfInterrupted,
    undoAfterSuccess: undo
  }
  const ifd = fs.openSync(intentPath, 'wx', 0o600)
  try { fs.writeSync(ifd, b4a.from(JSON.stringify(intent, null, 2) + '\n')); fs.fsyncSync(ifd) } finally { fs.closeSync(ifd) }
  fsyncDir(rollDir)

  // Printed BEFORE the renames, not just returned after them: if this process dies in the
  // window below, the operator's scrollback still holds the recovery command.
  log('')
  log('about to swap. If this is interrupted, the original core is at:')
  log(`  ${dest}`)
  log('and this puts it back:')
  log(`  ${recoverIfInterrupted}`)
  log(`(also recorded in ${intentPath})`)
  log('')

  // --- the two renames ----------------------------------------------------------------------
  // Order matters: the live core has to leave the path before the shadow can take it. Between
  // the two renames the panel has NO core at that path — which is why the panel must be
  // stopped, why the ELOCK check above matters, and why the intent file exists.
  fs.renameSync(liveCoreDir, dest)
  let installed = false
  try {
    fs.renameSync(shadowCoreDir, liveCoreDir)
    installed = true
  } catch (err) {
    // The second rename failed. Put the original back. NOTE: the success path must not throw
    // from inside this try — an earlier version did, and `catch (rollbackErr)` swallowed the
    // success message and re-reported it as the double failure, telling an operator whose disk
    // was in perfect shape that the live core was gone and the panel path empty, with a
    // recovery `mv` whose source did not exist. Every clause of that was false. So: recover
    // here, record the outcome, and throw OUTSIDE.
    let recovered = false
    let rollbackErr = null
    try { fs.renameSync(dest, liveCoreDir); recovered = true } catch (e2) { rollbackErr = e2 }
    try { fs.rmSync(intentPath, { force: true }); fsyncDir(rollDir) } catch {}
    if (recovered) {
      throw new Error(`installing the compacted core failed (${err.message}); the ORIGINAL core has been put back at ` +
        `${liveCoreDir} and the box is exactly as it was found. NOTHING WAS LOST and no recovery action is needed. ` +
        'Investigate the cause before retrying.')
    }
    throw new Error(`installing the compacted core failed (${err.message}) AND putting the original back ALSO failed ` +
      `(${rollbackErr && rollbackErr.message}). THE ORIGINAL CORE IS AT ${dest} AND THE PANEL PATH IS EMPTY. ` +
      `Do NOT start the panel — it would create a new empty core there. Restore by hand:\n  ${recoverIfInterrupted}`)
  }

  // Both directory entries have to be on stable storage, or a power cut here could resurrect a
  // half-applied swap.
  const syncs = [fsyncDir(path.dirname(liveCoreDir)), fsyncDir(rollDir), fsyncDir(path.dirname(shadowCoreDir))]

  // The swap is complete; the window the intent file describes is closed.
  if (installed) { try { fs.rmSync(intentPath, { force: true }); fsyncDir(rollDir) } catch {} }

  const sizesAfter = { live: statParts(liveCoreDir), rollback: statParts(dest) }
  return {
    discoveryKey: disc,
    keyHex: shadow.keyHex,
    fork: shadow.fork,
    liveForkBefore: liveNow.fork,
    movedLiveTo: dest,
    installedFrom: shadowCoreDir,
    liveCoreDir,
    sizes: {
      before: sizesBefore,
      after: sizesAfter,
      // NOT freed yet — the rollback is on the same filesystem by design, so these bytes are
      // still allocated until a human deletes it. Named to stop the summary claiming otherwise.
      reclaimableBytes: sizesBefore.live.total - sizesAfter.live.total,
      rollbackHoldsBytes: sizesAfter.rollback.total
    },
    fsync: syncs,
    undoCommand: undo,
    intentPath,
    receiptPath: rp
  }
}

// =========================================================================================
// CLI
// =========================================================================================

function parseArgs (argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    opts[k] = v
  }
  return opts
}

const SELF = path.basename(fileURLToPath(import.meta.url))
const USAGE = `usage: node ${SELF} <subcommand> [flags]

  report   --data-dir <p> [--store <p>] [--public-key <hex>] [--metadata-only]
           read-only: fork/length/byteLength/keyCount + allocated and apparent sizes.
           Works on a METADATA-ONLY core dir (oplog+tree+bitfield, no \`data\`) — a ~5.6 MB
           copy is enough for a pre-flight on a live box. The live key count needs \`data\`
           and is reported as null without it; --metadata-only skips that walk explicitly.

  dump     --data-dir <p> --out <p> [--public-key <hex>]
           stream every live entry to NDJSON + <out>.meta.json (read-only, fsynced).
           --out must be OUTSIDE DATA_DIR. --public-key lets the dump run without ever
           opening the file that holds the secret key.

  rebuild  --data-dir <p> --dump <p> --store <p> --fork <n>
           replay the dump into a fresh core at fork <n> (must be dumpFork+1)

  verify   --data-dir <p> --dump <p> --store <p> --fork <n> [--no-live-compare]
           full verification; writes <store>/verify-receipt.json. RUN AS ITS OWN PROCESS.
           --data-dir makes it re-walk the LIVE bee and compare key-for-key, which is the
           only check that can catch a dump that was short or stale (~2 s on the real core).
           --no-live-compare skips that; \`swap\` then REFUSES the receipt.

  swap     --data-dir <p> --shadow-store <p> --rollback-dir <p> --i-have-stopped-the-panel
           move the live core OUT of DATA_DIR and install the compacted one. Opens the live
           core first: refuses if it is not byte-for-byte the one that was dumped, or if
           anything still holds it open (a running panel surfaces as ELOCKED).

--rollback-dir must be OUTSIDE DATA_DIR and on the same filesystem; see the header comment.
Each subcommand prints human text, then one final line of JSON.`

function need (opts, flag, sub) {
  const v = opts[flag]
  must(typeof v === 'string' && v.length > 0, `${sub}: --${flag} is required.\n\n${USAGE}`)
  return v
}

function emit (obj) { log(JSON.stringify(obj)) }

async function main () {
  const argv = process.argv.slice(2)
  const sub = argv[0]
  const opts = parseArgs(argv.slice(1))

  if (!sub || sub === 'help' || opts.help) { log(USAGE); return 0 }

  if (sub === 'report') {
    const dataDir = need(opts, 'data-dir', 'report')
    const storeDir = typeof opts.store === 'string' ? opts.store : dataDir
    const keyHex = typeof opts['public-key'] === 'string' ? opts['public-key'].toLowerCase() : readSigningPublicKeyHex(dataDir)
    const coreDir = coreDirFor(storeDir, keyHex)
    // If --rollback-dir is given, say loudly whether a swap was interrupted. `report` is the
    // first thing anyone runs when something looks wrong, so it is the right place to find this.
    if (typeof opts['rollback-dir'] === 'string') {
      const stranded = findIntent(opts['rollback-dir'])
      if (stranded) {
        log('!! A SWAP DID NOT FINISH !!')
        log(`   ${stranded.path}`)
        if (stranded.intent) {
          log(`   the original core was moved to  ${stranded.intent.dest}`)
          log(`   put it back with:               ${stranded.intent.recoverIfInterrupted}`)
        }
        log('   Do not start the panel until this is resolved — it would create a new empty core at the live path.')
        log('')
      }
    }
    must(fs.existsSync(coreDir), `no core directory at ${coreDir} — check --data-dir/--store and --public-key.`)
    // A core opens, and reports fork/length/byteLength/contiguousLength correctly, from
    // oplog+tree+bitfield ALONE — `data` holds only the block payloads. That makes a
    // metadata-only pre-flight possible on a copy of ~5.6 MB instead of 13.7 GB, so `report`
    // must never assume `data` is there. Walking the bee for a live key count does need it, so
    // that one number is skipped (reported as null) rather than the whole subcommand failing.
    const hasData = fs.existsSync(path.join(coreDir, 'data'))
    const countKeys = hasData && opts['metadata-only'] !== true
    const { store, core } = await openReadOnly(storeDir, keyHex)
    let summary = null
    try {
      let keyCount = null
      let payloadBytes = null
      if (countKeys) {
        const db = new Hyperbee(core, { keyEncoding: 'binary', valueEncoding: 'binary' })
        await db.ready()
        keyCount = 0
        payloadBytes = 0
        // Counting means walking the B-tree — only the LIVE blocks, ~6.5 MB of a 13.7 GB core,
        // because the dead weight is precisely what nothing reaches any more.
        for await (const node of db.createReadStream()) { keyCount++; payloadBytes += node.key.length + node.value.length }
      }
      const shape = coreShape(core)
      const storage = await storageInfo(core)
      const parts = statParts(coreDir)
      summary = {
        phase: 'report',
        storeDir: path.resolve(storeDir),
        coreDir,
        ...shape,
        keyCount,
        payloadBytes,
        metadataOnly: !countKeys,
        dataFilePresent: hasData,
        storage,
        onDisk: parts.files,
        onDiskTotal: parts.total,
        rebuildAtFork: shape.fork + 1
      }
      log(`core       ${shape.keyHex}`)
      log(`dir        ${coreDir}`)
      log(`fork       ${shape.fork}`)
      log(`length     ${shape.length} block(s), contiguous ${shape.contiguousLength}`)
      log(`byteLength ${shape.byteLength} B (${fmt(shape.byteLength)})`)
      if (countKeys) log(`live       ${keyCount} key(s), ${payloadBytes} B of key+value payload (${fmt(payloadBytes)})`)
      else if (!hasData) log('live       n/a — no `data` file in this core dir (metadata-only copy); fork/length/byteLength above are still exact')
      else log('live       n/a — --metadata-only, the B-tree walk was skipped')
      log('on disk (apparent size):')
      for (const f of CORE_FILES) log(`  ${f.padEnd(9)} ${parts.files[f] ? parts.files[f].size + ' B (' + fmt(parts.files[f].size) + ')' : 'absent'}`)
      log(`  ${'TOTAL'.padEnd(9)} ${parts.total} B (${fmt(parts.total)})`)
      // core.info({storage:true}) reports ALLOCATED bytes per file, keyed exactly like this —
      // `blocks` is the data file. Printed under its own names so it can be matched against the
      // API rather than against a label invented here. Allocation is what `df` sees; for a
      // hole-punched core the apparent sizes above overstate it.
      if (storage) {
        log('allocated (core.info({storage:true})):')
        for (const k of ['blocks', 'tree', 'bitfield', 'oplog']) {
          log(`  ${k.padEnd(9)} ${storage[k]} B (${fmt(storage[k])})${k === 'blocks' ? '   <- the `data` file' : ''}`)
        }
      }
      log(`\nrebuild at fork ${shape.fork + 1} (dump fork + 1 — never the same fork)`)
    } finally { await store.close() }
    emit(summary)
    return 0
  }

  if (sub === 'dump') {
    const dataDir = need(opts, 'data-dir', 'dump')
    const outPath = need(opts, 'out', 'dump')
    const publicKey = typeof opts['public-key'] === 'string' ? opts['public-key'] : null
    log(`dumping the panel bee from ${path.resolve(dataDir)} -> ${path.resolve(outPath)}`)
    const r = await dumpBee({ dataDir, publicKey, outPath })
    log(`  ok  ${r.keyCount} live entries, ${fmt(fs.statSync(r.dumpPath).size)} of NDJSON`)
    log(`  ok  sha256 ${r.dumpSha256}`)
    log(`  ok  live core: fork ${r.fork}, length ${r.length}, byteLength ${fmt(r.byteLength)}`)
    log(`  ok  read-only proof: ${CORE_FILES.map((f) => f + '=' + (r.readOnlyProof[f] ? 'unchanged' : 'CHANGED')).join(' ')}`)
    log(`  ok  sidecar ${r.metaPath}`)
    log(`\nnext:  node ${SELF} rebuild --data-dir ${dataDir} --dump ${r.dumpPath} --store <shadow> --fork ${r.rebuildAtFork}`)
    emit({ phase: 'dump', ...r })
    return 0
  }

  if (sub === 'rebuild') {
    const dataDir = need(opts, 'data-dir', 'rebuild')
    const dumpPath = need(opts, 'dump', 'rebuild')
    const storeDir = need(opts, 'store', 'rebuild')
    const meta = readDumpMeta(dumpPath)
    must(typeof opts.fork === 'string',
      `rebuild: --fork is required and is never inferred for you. For this dump (fork ${meta.fork}) the only safe value ` +
      `is --fork ${meta.fork + 1}.\n\n${USAGE}`)
    const fork = Number(opts.fork)
    const keyPair = readSigningKeyPair(dataDir)
    log(`rebuilding ${meta.keyCount} entries into ${path.resolve(storeDir)} at fork ${fork} (live core is at fork ${meta.fork})`)
    const r = await shadowRebuild({ dumpPath, keyPair, storeDir, fork, dataDirHint: dataDir })
    log(`  ok  ${r.keyCount} entries, length ${r.length}, fork ${r.fork}, byteLength ${fmt(r.byteLength)}`)
    log(`  ok  oplog flushed into tree: ${r.oplogFlushed}`)
    for (const f of CORE_FILES) log(`  ..  ${f.padEnd(9)} ${r.onDisk[f] ? r.onDisk[f].size + ' B' : 'absent'}`)
    log(`  ok  core dir ${r.coreDir}`)
    log(`\nnext (SEPARATE PROCESS):  node ${SELF} verify --data-dir ${dataDir} --dump ${dumpPath} --store ${storeDir} --fork ${fork}`)
    emit({ phase: 'rebuild', ...r })
    return 0
  }

  if (sub === 'verify') {
    const dumpPath = need(opts, 'dump', 'verify')
    const storeDir = need(opts, 'store', 'verify')
    const liveCompare = opts['no-live-compare'] !== true && opts['no-live-compare'] !== 'true'
    const dataDir = liveCompare ? need(opts, 'data-dir', 'verify') : (typeof opts['data-dir'] === 'string' ? opts['data-dir'] : null)
    const meta = readDumpMeta(dumpPath)
    must(typeof opts.fork === 'string',
      `verify: --fork is required. For this dump (fork ${meta.fork}) it must be ${meta.fork + 1}.\n\n${USAGE}`)
    log(`verifying ${path.resolve(storeDir)} against ${path.resolve(dumpPath)}` +
      (liveCompare ? ` and the LIVE bee at ${path.resolve(dataDir)}` : ' (LIVE COMPARE SKIPPED)'))
    const r = await verifyShadow({ dumpPath, storeDir, expect: { fork: Number(opts.fork) }, dataDir, liveCompare })
    const flagged = r.checks.filter((c) => c.flagged)
    log(`\nVERIFIED ✅  ${r.keyCount} entries, fork ${r.fork}, byteLength ${fmt(r.byteLength)}` +
      (flagged.length ? `  (${flagged.length} flagged, non-fatal)` : ''))
    log(`  merkle root ${r.fingerprint.treeHash}`)
    if (!r.liveCompare) log('  NOT compared against the live bee — `swap` will refuse this receipt.')
    log(`receipt ${r.receiptPath}`)
    emit({ phase: 'verify', ...r })
    return 0
  }

  if (sub === 'swap') {
    const dataDir = need(opts, 'data-dir', 'swap')
    const shadowStoreDir = need(opts, 'shadow-store', 'swap')
    const rollbackDir = need(opts, 'rollback-dir', 'swap')
    // `--i-have-stopped-the-panel` and `--i-have-stopped-the-panel true` both count; anything
    // else does not. Being pedantic here would only produce a "flag is required" message at the
    // operator who plainly did pass it.
    must(opts['i-have-stopped-the-panel'] === true || opts['i-have-stopped-the-panel'] === 'true',
      'swap: --i-have-stopped-the-panel is required. It is spelled out rather than -y because between the two renames ' +
      'there is no core at the panel\'s path, and a panel that is still running would be writing into a directory that ' +
      `no longer exists.\n\n${USAGE}`)
    const r = await swapCore({ dataDir, shadowStoreDir, rollbackDir, confirm: true })
    log(`SWAPPED ✅  core ${r.discoveryKey}, fork ${r.liveForkBefore} -> ${r.fork}`)
    log(`  old (live)  ${fmt(r.sizes.before.live.total)}  ->  moved to ${r.movedLiveTo}`)
    log(`  new (built) ${fmt(r.sizes.after.live.total)}  ->  installed at ${r.liveCoreDir}`)
    log('')
    // The rollback is on the SAME filesystem by design, so nothing has actually been returned
    // to the volume yet. Saying "freed" here would tell an operator who came to this because of
    // an ENOSPC outage that the outage is over, when `df` has not moved a byte.
    log(`DISK: ${fmt(r.sizes.reclaimableBytes)} WILL BE FREED when you delete the rollback copy.`)
    log(`      \`df\` will not change until then — the rollback is on the same filesystem on purpose,`)
    log(`      and still holds ${fmt(r.sizes.rollbackHoldsBytes)} at ${r.movedLiveTo}`)
    log('')
    log('TO ROLL BACK (two renames, nothing is deleted):')
    log(`  ${r.undoCommand}`)
    log('')
    log('The old core is OUTSIDE DATA_DIR on purpose: the panel deletes stray 64-hex core dirs under')
    log('DATA_DIR/cores on every start. Keep it until the panel has been up and serving for a while,')
    log('then delete it yourself — that is the step that actually frees the disk.')
    emit({ phase: 'swap', ...r })
    return 0
  }

  log(`unknown subcommand ${JSON.stringify(sub)}\n\n${USAGE}`)
  return 2
}

// Importable as a module; only runs the CLI when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code), (err) => {
    console.error('\nFAILED: ' + (err && err.message ? err.message : String(err)))
    if (process.env.PANEL_COMPACT_TRACE) console.error(err && err.stack)
    process.exit(1)
  })
}
