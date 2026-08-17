# Compacting the panel bee (fork + shadow rebuild)

The panel's signed Hyperbee is an append-only log. Nothing in the system ever
reads its history — a bee enters at the current root and descends, and a sweep
of every package finds zero `checkout(`, zero `createDiffStream(` and zero
`createHistoryStream(` — but the superseded blocks stay on disk forever. A
write-amplification bug can therefore turn a ~20 MB working set into a
multi-gigabyte file that nothing will ever reclaim on its own.

This page is the procedure for getting that space back **without changing the
panel key**. It is a last resort, not maintenance: fix the writer first, then
compact once.

## When you need it

Symptom: `<DATA_DIR>/cores/<xx>/<yy>/<disc>/data` is orders of magnitude larger
than the live state. Compare `core.length` against the number of live keys — a
healthy panel bee sits around 20 MB and grows by roughly nothing over a day
(see [Scaling](scaling.md)).

Before compacting, **find and ship the fix for whatever wrote all that**.
Compaction buys back the disk once; a writer still amplifying refills it.

## The one trap: the fork counter is inside the signature

`hypercore/lib/caps.js` signs the `fork` field along with the tree. This makes
the obvious approach — "rebuild the bee in a temp dir and swap it in" —
catastrophic, because **a fresh core starts at fork 0**:

| Rebuilt at | What every peer holding an old block does |
|---|---|
| the **same** fork | Two valid signatures at one length → `Core#checkConflict` → `_closeAllSessions(err)`. Every client session dies, unrecoverably. |
| **`oldFork + 1`** | `checkConflict` returns false on its first line and peers take the **reorg** path instead. They re-sync transparently. |

So the rebuilt core must be stamped with the next fork *before* anything is
written to it. A zero-length truncate needs no signature, which is what makes
that possible on an empty core:

```js
const core = store.get({ keyPair: keys.signing })
await core.truncate(0, { fork: oldFork + 1 })   // now append
```

This is load-bearing. `tools/e2e-panel-compact-test.mjs` carries a deliberate
failure lane that rebuilds at the *same* fork and asserts a stale client really
does emit `'conflict'`, so that nobody can "simplify" the fork bump away later
without a test going red.

## Two things that look right and are not

**Do not `core.clear()` in place.** `fs-native-extensions` is an
*optionalDependency*. When it is absent, `random-access-file`'s delete path
calls back **success having freed zero bytes** — while the bitfield is
destroyed, and a bitfield cannot be un-cleared. It also collapses
`contiguousLength` to 1, so the panel stops advertising availability to cold
peers, and the panel then parks forever trying to download its own cleared
blocks from a peer that does not have them.

**Do not `truncate()` in place.** The instant `_flushOplog()` returns, the tree
file is ftruncated — and the tree is the only thing that can address the data
bytes. `Core#audit` cannot rescue it, because it rebuilds the bitfield *from*
the tree. Blast radius is total, permanent loss of accounts, catalog and
grants, with no peer to restore from. Note also that `_truncate` never touches
`this.blocks`: truncate alone frees only the merkle tree, which is about 7% of
the store. It is not a reclaim even when it works.

In-place `clear()` fails by hanging. In-place `truncate()` fails by losing
everything. The shadow rebuild below never mutates the live core at all — its
riskiest step is a directory rename with a rollback.

## Preconditions

- **A verified recovery archive on a volume with room for it**, taken *after*
  the last write you care about. `deploy/backup.sh -o <dir> panel`. Verify it
  (`gzip -t`, and list the archive to confirm `keys/`, `secrets/`, `cores/` and
  `primary-key` are all in there) before you touch anything.
- **Disk headroom.** Nothing in the procedure needs a second copy of the store,
  but the pre-swap core stays on disk as the rollback until you delete it.
- **The panel stopped** for the dump, rebuild and swap. Viewers keep playing;
  only new logins pause.
- **Run the tool with the deployed module versions.** On a Docker deployment
  that means inside a container from the panel image, with the volume mounted —
  not from a checkout on the host. `tools/panel-compact.mjs` is deliberately a
  single file with no repo-relative imports so it can be bind-mounted in.

## The procedure

Rollback is a `mv` at every step up to the last one.

**1. Stop the panel and take the archive.**

```bash
cd /opt/aliran && docker compose stop panel
./deploy/backup.sh -o <backup-dir> panel
```

`backup.sh` restarts the service when it is done. Confirm with `docker ps` —
**not** `docker compose ps`, which has been observed reporting `Up` for an
exited container — then stop it again for the rest of the procedure.

**Running the tool.** `tools/panel-compact.mjs` is deliberately a single file
importing nothing but node built-ins and the panel's own direct dependencies,
so it can be bind-mounted next to them and run against the *exact* deployed
module versions. Every path is a flag; nothing is hardcoded:

⚠ **Mount the shared PARENT once — not the volume and the rollback separately.**
Two bind mounts are two mount points, and `rename()` across mount points fails
`EXDEV` *even when both sit on the same device*. Measured: `st.dev` 2048 on both
sides, probe rename still refused. So mount the directory that contains both:

```bash
docker run --rm --network none \
  -v /mnt/<volume-root>:/host \
  -v /root/panel-compact/panel-compact.mjs:/app/panel/panel-compact.mjs \
  --entrypoint node aliran-panel \
  /app/panel/panel-compact.mjs <subcommand> \
    --data-dir /host/docker/volumes/aliran_panel-data/_data …
```

`docker volume inspect aliran_panel-data` prints the volume's host path; the
rollback directory goes somewhere else under the same `/host` mount. The tool
renames a probe file across before it moves anything and refuses if that fails.
A `st.dev` comparison would have given a false pass here — both mounts report
the same device — so the probe is the check that actually works.

⚠ Do **not** park the rollback inside the volume's own directory next to
`_data`. It would be outside `DATA_DIR` and pass every check, but a later
`docker volume rm` would take the rollback with the volume.

⚠ **The panel must stay stopped from `dump` until `swap`.** Anything it writes
in between — and it writes on every start, plus continuously from
`liveness.js` — is not in the dump and is therefore discarded by the swap. The
tool refuses if the live core has moved since the dump, but the cheapest fix is
not to give it the chance: one window, panel down throughout.

⚠ **Use ONE mount layout for the whole procedure.** The verify receipt records
the store path it verified, and `swap` refuses a receipt written for a different
path. That is deliberate — it is what stops a stale receipt authorising a
different shadow — but it means changing `-v` flags mid-run costs you a re-verify.

**2. Dump every live key.** Read-only. Pass `--public-key` and the dump never
opens the file holding the secret at all. The tool records size, mtime and mode
across all of `DATA_DIR` — the core files plus `keys/`, `secrets/`,
`primary-key`, `sources.json`, `packages.json` — before and after, and fails if
anything moved.

```bash
node panel-compact.mjs dump --data-dir /data --out /work/bee.ndjson
```

Values are dumped as **raw bytes**, never round-tripped through JSON — a
re-encode that reordered object keys would silently rewrite every user's signed
record. Note the reported `fork`; the tool prints the fork to rebuild at.

⚠ The session is opened `writable: false`, and the tool asserts it. Opening by
public key alone is **not** enough: the panel persists its secret key in the
core's oplog header, so a key-only session comes back writable.

**3. Rebuild in a temp store, at the next fork.**

```bash
node panel-compact.mjs rebuild --data-dir /data --dump /work/bee.ndjson \
  --store /work/shadow --fork <printed by step 2>
```

Every key goes in through **one** `db.batch()`, which flushes as a single
`core.append(array)`. (Strictly it is two appends: hyperbee writes its 10-byte
header on the first `put`. A crash between them leaves a valid empty bee.)
`--fork` is mandatory, never defaulted, and is checked against the dump's
recorded fork — the tool refuses to rebuild at the same fork.

**4. Verify, in a separate process.** This is the gate. Nothing it asserts may
come from a cache warmed by the process that did the writing.

```bash
node panel-compact.mjs verify --data-dir /data --dump /work/bee.ndjson \
  --store /work/shadow --fork <same>
```

It checks the key and discovery key are unchanged, the fork is the expected
one, `Hyperbee.isHyperbee`, block 0 byte-identical, every value byte-identical,
**no extra keys** (a lockstep walk of both sorted streams, which proves
presence, ordering and absence in one pass), and that the bee still reads
through the panel's own `utf-8`/`json` encodings. It writes the receipt that
`swap` refuses to proceed without.

⚠ `--data-dir` is what makes this a real gate. Without it, verify only proves
*the shadow equals the dump* — and since the dump's checksum and key count are
computed in the same pass that writes it, a **short** dump is perfectly
self-consistent. Drop three entries, re-stamp the sidecar, and everything else
passes. With `--data-dir` it re-walks the LIVE bee and compares key-for-key with
the dump out of the loop entirely. It costs about 2 s on the real core.
`--no-live-compare` exists, and `swap` refuses the receipt it produces.

**5. Swap one directory.** The path `cores/<xx>/<yy>/<disc>` is identical in
both stores, and a core opened by explicit keyPair carries no corestore
userData, so the directory is portable between stores. `primary-key`, `keys/`,
`secrets/` and the assets and updates cores are untouched.

```bash
node panel-compact.mjs swap --data-dir /data --shadow-store /work/shadow \
  --rollback-dir /rollback --i-have-stopped-the-panel
```

`swap` opens the live core before it moves anything, and refuses unless it is
byte-for-byte the core that was dumped — same key, same fork, same length, same
`byteLength` — with the new fork computed from **the live core**, not from the
dump sidecar. Two things fall out of that, and both matter more than they sound:

- **A stale dump can no longer be swapped in.** Re-running the procedure from a
  saved dump against a core that has since moved would otherwise install a
  second, different core at a fork the live one already occupies — which is the
  conflict case, on every client at once.
- **`--i-have-stopped-the-panel` stops being an honour system.** Opening the
  core takes the same OS lock every core file holds, so a running panel now
  surfaces as `THE PANEL IS STILL RUNNING`. Without that check, a swap under a
  running panel *succeeds* on Linux — `rename(2)` on a directory with open file
  descriptors is legal, the panel keeps writing into the moved inode, and every
  one of those writes disappears at restart.

It writes a `SWAP-IN-PROGRESS.json` intent file before the first rename and
removes it after the second, and prints both `mv` commands *before* touching
anything — so an interrupted swap leaves a record of what was in flight instead
of a bare directory and a mystery. If you find one, do not start the panel:
`openStore` would create an empty core at the same key and fork, which is the
conflict case again.

⚠ **The rollback must live outside `DATA_DIR`.** `store.js`'s
`reclaimStrayCores()` runs on *every* panel start and `rmSync`es every leaf
under `<DATA_DIR>/cores/**` whose name is 64 hex characters and is not one of
the panel's five own cores. Park the pre-swap core inside that tree and the
panel deletes your only rollback the next time it starts. Same filesystem, so
the rename is instant and atomic; different directory, so nothing sweeps it.

**6. Verify the swapped-in store before exposing it**, with the panel still
stopped:

```bash
node panel-compact.mjs report --data-dir /data
```

Expect the new fork, the live key count, and a `storage.blocks` that is now
megabytes rather than gigabytes.

**7. Start the panel and watch a real client converge.** Confirm a viewer
reaches the new fork, keeps its session, and still sees its full lineup.

**8. Only then, delete the rollback.** This is the step that actually frees the
space, and the only irreversible one.

```bash
rm -rf /rollback/<disc>
```

⚠ Until you run that, **`df` does not move**. The rollback is on the same
filesystem by necessity — that is what makes the swap a rename — so the swap
itself frees nothing. If you are doing this because a disk filled up, the
outage is not over until this step.

## Rolling back

Up to step 8, rollback is two renames in the opposite order: move the shadow
core out of `DATA_DIR/cores/<xx>/<yy>/`, move `<rollback>/<disc>` back into it,
start the panel. The tool prints the exact command when it swaps. Clients that
already reorged to fork+1 will see the old fork again — which is a fork
*backwards* and not something peers handle gracefully, so treat a rollback
after clients have converged as a last resort, and prefer rolling forward.

## Everything else that holds a copy of the bee

A reorg does **not** shrink a replica. `_truncate` never touches `this.blocks`,
so a peer keeps its data file fully allocated and then writes the new, shorter
core over the head of it — stranding the tail. Every full replica needs a
manual purge to actually reclaim.

- **The EPG service.** It keeps a sparse-but-large replica of the panel bee in
  its own store to map `epgId → streamId`. Its core sits under the *same*
  discovery key as the panel's — which is how to find it, and also why it is
  easy to mistake for guide data when reading `du` output. Stop the service,
  `rm -rf` that one core directory, start it: the replica re-downloads what it
  needs. Do **not** touch the epoch drive cores or `epoch.json` — the service
  refuses to start if the recorded `driveKey` and the store disagree.

  Purge it **after** the panel fork, not before. Afterwards it re-replicates the
  new, small core; beforehand it would pull from the old fat one and you would
  pay for the download twice.
- **Repeaters with `PANEL_DATA=1`.** `_armPanelMirror()` does
  `core.download({ start: 0, end: -1 })`, so such a repeater holds the bee in
  full and keeps that allocation after the reorg. The repeater store is
  declared disposable cache, so the fix is sanctioned: stop it, `rm -rf` the
  core directory, start it.
- **Viewer clients keep working, but see the section below first.** `allowFork`
  defaults true and `eagerUpgrade` is hardcoded true, so the reorg applies
  without a pending read. Sessions stay open, no `'conflict'` is raised, reads
  keep working, and cold devices bootstrap normally. The panel key never moves,
  so the pairing code, the swarm topic and every outstanding session token stay
  valid.

## ⚠ Every open `bee.watch(range)` goes deaf at the fork

**This is the real cost of the procedure, and the published wisdom about it is
wrong.** It is widely assumed that hyperbee's range watcher is fork-aware
because `Watcher._next()` contains

```js
if (this.current.core.fork !== this.previous.core.fork) return await this._yield()
```

**That guard cannot fire.** `hypercore/index.js` defines
`get fork () { return this.core.tree.fork }` — a live read of the shared core,
not a value captured at snapshot time. `current` and `previous` are two sessions
over the *same* core, so both report the *new* fork the moment the watcher
wakes, and the condition is false.

What happens next has two faces, and it is worth knowing both because only one
of them is visible:

- **It throws.** The Watcher holds bee snapshots taken before the truncate, and
  `hypercore/index.js:844` throws `SNAPSHOT_NOT_AVAILABLE` once
  `index >= _snapshot.compatLength`. Measured in 3 of 6 runs: two errors about
  5 s into the reorg, one per watcher.
- **It parks silently.** In the other runs the `for await` neither threw nor
  yielded. The differ was entered with a `previous` version the truncated tree
  no longer contains, and `next()` never resolved and never rejected.

⚠ **A `while (!this._closed)` re-arm wrapper does not fix this** — the shape
used by `repeater/src/index.js` and `epg/src/guide.js`. It handles the throwing
face and does nothing for the silent one, because the loop never exits. The fix
has to re-create the watcher on the core's `truncate` event. Patched that way in
a test, a post-fork catalog edit reached a warm viewer in **208 ms**.

Re-growing the log past its pre-fork length does not reliably restore delivery
either — measured over 1,006 appends. Treat the watcher as dead until the
process restarts.

The blast radius is bounded, and worth stating precisely:

- It parks **only that watcher**. The Watcher holds its own `mutexify()` lock,
  separate from the bee's write lock, so reads, writes and `getAndWatch` are
  all unaffected. A viewer keeps its lineup and keeps playing.
- It affects **only sessions that were already open across the swap**. A client
  that connects afterwards arms its watcher on the new tree and is fine.
- It heals on **process restart** — for a television, on the next app launch.

So: everything that watches a range must be restarted after the swap. In this
repo that is `sdk/player.js` `_watchCatalog` / `_watchGrants` / `_watchEpgKey`,
`repeater/src/index.js` (both watchers), and `epg/src/guide.js`. Restart the EPG
service and any repeaters yourself; running viewer apps will not see catalog or
grant changes until they are relaunched. Schedule the swap accordingly.

`_maybeReresolveActiveFeed` rides the same loop, so a warm viewer also stops
following broadcaster feedKey rotations — if a feed it is watching rotates
afterwards, it keeps replicating the dead one until the viewer re-zaps or
restarts. That is the sharpest edge of this, and it is the reason to pick a
quiet hour.

What is **not** affected, all measured rather than assumed: the lineup itself
never truncates (a sweep landing mid-reorg emitted the full list — the client
reorgs in about 2 s and the rebuilt bee is readable before any sweep arrives);
sessions and tokens stay valid with no re-login; pre-fork entitlements
re-resolve and serve byte-identical segments; cold installs are clean. And the
fork is **not** misclassified as corruption — `SNAPSHOT_NOT_AVAILABLE` is not in
`sdk/recover.js`'s `CORRUPT_CODES` and does not match its message regex, so
there are **zero** replica purges.

A full mirror also sees its `contiguousLength` collapse to **1** after the
reorg — hypercore truncates to the shared prefix and re-appends — so it stops
advertising availability to cold peers until it re-downloads. Sparse viewers are
unaffected (their `contiguousLength` is 0 either way, because a hyperbee reader
never fetches block 0).

⚠ Before publishing a fork, confirm the fork-aware watcher check is present in
the **oldest client bundle still in the field**, not just in the installed
tree. The dependency floor is looser than the installed version, and a device
runs whatever was bundled when it was built. The guard lives in `Watcher._next()`,
not in any `RangeWatcher` class — grepping for the class name gives a false
negative. It has been in hyperbee since **2.13.4**, so any version a `^2.20.0`
range can resolve to already has it.

⚠ Watch for a spike in recoveries after publishing. `sdk/recover.js` classifies
`EPARTIALREAD` and any message matching `/could not satisfy length/i` as on-disk
corruption — and those are *truncation* errors, which is what a fork produces.
`_watchCatalog` wraps its push in `_recover(...)`, so a read that races the
reorg could be misread as a corrupt store and trigger a full replica purge.
That is expensive, not fatal: the replica re-downloads. But it is the difference
between a transparent re-sync and a visible stall on a slow television, so
measure it rather than assuming it.

## Verifying the reclaim

`core.info({ storage: true })` reports allocated bytes per file as
`{ oplog, tree, blocks, bitfield }`. `blocks` is the data file — that is the
number that should collapse. Compare it against `stat -c %s` on the data file
itself, and against the live key count, before and after.

## Measured, on the SolTV deployment

A full rehearsal against a copy of the real store, taken on the box itself:

| | before | after |
|---|---|---|
| `core.length` | 70,154 | 2,638 |
| `byteLength` | 13,731,002,445 B | 6,779,942 B |
| on-disk `data` | 13,731,002,445 B | 6,779,942 B |
| `fork` | 0 | 1 |

2,637 live keys carrying 6,751,478 B of key+value payload — a 26.6:1 ratio of
dead blocks to live ones, and **99.95% reclaimed**. The `byteLength` of the
rebuilt core is 1.004× the raw payload, so essentially nothing is overhead.

Timings, which are worth knowing before you plan a maintenance window: `cp -a`
of the whole 14 GB volume took **116 s**, and the panel was down **118 s** for
it. The compaction itself — dump, rebuild, verify, swap — took **6 s** end to
end. The swap is a rename, so it is instant regardless of core size.

Rollback was exercised on that same real data: two renames back reopened at
`fork 0, length 70154, byteLength 13731002445` with all 2,637 keys and 10 user
records intact, then two renames forward returned to the compacted core. The
pre-swap core is left byte-identical by the whole procedure, which is also the
best evidence that `dump` really is read-only.

The GC hazard above is not hypothetical. Planting a decoy directory named 64 hex
characters under `DATA_DIR/cores/` and then starting the panel's `openStore`
logs `[gc] reclaimed 1 stray core dir(s)` and the decoy is gone. A rollback
parked there would go with it.
