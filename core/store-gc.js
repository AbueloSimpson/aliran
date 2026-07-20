// Corestore whole-namespace GC.
//
// NOT re-exported from index.js on purpose (same reason as net-tune.js): this module walks
// the filesystem and is server-side only, while index.js is bundled into the Bare worklet.
// Import it by path:
//   import { purgeStaleCores } from '@aliran/core/store-gc.js'
//
// WHY THIS EXISTS
//
// A Corestore only tracks the cores it is currently holding open. Cores it opened once and
// let go stay on disk forever with nothing to collect them — and both server-side nodes
// accumulate them around a small, positively known set of cores they own:
//
//   broadcaster (channel.js `_gcStaleCores`) — a disk-mode channel's store accumulates the
//     metadata+blobs cores of EVERY feed generation it has ever run: a source change (or a
//     periodic rotation) bumps feedGen → a new namespace → brand-new cores, orphaning the
//     previous generation's core directories. blob clear() only reclaims the CURRENT feed's
//     rotated segment DATA; a retired generation's cores — including their append-only
//     merkle TREES, which clear() never touches — are dead weight that grows the store for
//     the channel's whole lifetime. This is the metadata analog of reconcileStaleEntries
//     (which drops stale ENTRIES within one namespace; this drops entire retired NAMESPACES).
//
//   panel (store.js `reclaimStrayCores`) — builds before the blobsKey enricher purged its
//     own probes stranded one metadata + one blobs core per DISTINCT feedKey ever probed, on
//     the panel's OWN corestore. The enricher no longer leaks, but nothing reclaims what
//     older builds already wrote.
//
// keepDiscoveryKeys = the hex discovery keys of the cores to KEEP. Every other 64-hex core
// directory under <storeDir>/cores/ is removed. Corestore lays cores out at
// cores/<id[0:2]>/<id[2:4]>/<id>/ (see its getStorageRoot); we ONLY ever touch that tree —
// never the primary-key / feed.key files alongside it. Returns { removed, bytesFreed }.
//
// SAFETY: with an empty keep set this is a no-op — it refuses to delete cores it cannot
// positively account for, so a caller that fails to resolve its live discovery keys leaks
// (safe, retried next pass) rather than nuking the store it was meant to bound. Only
// directories whose name is a full 64-char discovery key are ever considered, so stray files
// are left alone. Callers are expected to add their own guard on top: a keep set that is
// merely non-empty is not the same as one that is COMPLETE (see _gcStaleCores' `keep.size < 2`
// and reclaimStrayCores' `keep.size !== 3`).

import fs from 'fs'
import path from 'path'

export const DISCOVERY_HEX_RE = /^[0-9a-f]{64}$/

// Allocated bytes of every file under `dir` (st.blocks*512 where the FS reports it, else
// st.size). Used to report how much a namespace purge frees and to size a live feed's
// merkle tree. Best-effort — an unreadable/vanishing entry contributes 0.
function dirAllocBytes (dir) {
  let total = 0
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += dirAllocBytes(p)
    else { try { const st = fs.statSync(p); total += (st.blocks ? st.blocks * 512 : st.size) } catch {} }
  }
  return total
}

export function purgeStaleCores (storeDir, keepDiscoveryKeys) {
  const keep = keepDiscoveryKeys instanceof Set ? keepDiscoveryKeys : new Set(keepDiscoveryKeys || [])
  const out = { removed: 0, bytesFreed: 0 }
  if (keep.size < 1) return out // refuse to run without a positive keep set
  const coresDir = path.join(storeDir, 'cores')
  let l1 = []
  try { l1 = fs.readdirSync(coresDir, { withFileTypes: true }) } catch { return out }
  for (const a of l1) {
    if (!a.isDirectory()) continue
    const aDir = path.join(coresDir, a.name)
    let l2 = []
    try { l2 = fs.readdirSync(aDir, { withFileTypes: true }) } catch { continue }
    for (const b of l2) {
      if (!b.isDirectory()) continue
      const bDir = path.join(aDir, b.name)
      let leaves = []
      try { leaves = fs.readdirSync(bDir, { withFileTypes: true }) } catch { continue }
      for (const leaf of leaves) {
        if (!leaf.isDirectory() || !DISCOVERY_HEX_RE.test(leaf.name) || keep.has(leaf.name)) continue
        const leafDir = path.join(bDir, leaf.name)
        const bytes = dirAllocBytes(leafDir)
        try { fs.rmSync(leafDir, { recursive: true, force: true }); out.removed++; out.bytesFreed += bytes } catch {}
      }
    }
  }
  return out
}
