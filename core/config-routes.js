// The /api/config and /api/backups routes, shared by all four dashboards.
//
// Server-side only; import by path:
//   import { makeConfigRoutes } from '@aliran/core/config-routes.js'
//
// TRANSPORT-AGNOSTIC ON PURPOSE
//
// This module imports no `http`. `handle()` takes a plain request descriptor and answers
// `{ status, body }` or null when the path is not one of ours, so each service adds a
// ten-line adapter to its existing router instead of a fifth copy of this logic. Panel,
// broadcaster, library and reseller are separate deployables with deliberately separate
// servers — but "which fields count as secret" and "what a restore refuses" must not drift
// between them, so those live here, once.
//
// THE ROUTES
//
//   GET    /api/config                       what this service supports + the section map
//   GET    /api/config/snapshots             on-box config snapshots, newest first
//   POST   /api/config/snapshots             {note?} take one now
//   GET    /api/config/snapshots/:id         METADATA ONLY — never the contents (see below)
//   POST   /api/config/snapshots/:id/plan    {…opts} dry run: exactly what would change
//   POST   /api/config/snapshots/:id/restore {…opts, confirm:true} apply it
//   DELETE /api/config/snapshots/:id
//   GET    /api/config/template              the secret-free template, for download
//   POST   /api/config/template/plan         {template} dry run an import
//   POST   /api/config/template/import       {template, …opts, confirm:true} apply
//   GET    /api/backups                      the disaster-recovery archives + the commands
//
// TWO RULES THIS LAYER ENFORCES, NOT THE UI
//
//   1. A CONFIG SNAPSHOT IS NEVER SERVED. GET /snapshots/:id answers metadata and section
//      summaries; the bytes stay in the volume. A snapshot holds per-stream keys, push
//      stream keys and password verifiers, and the moment it is fetchable over HTTP it can
//      land in a downloads folder, a browser cache or a proxy log. The download route is
//      guarded by isDownloadable(), which requires kind:'template' AND contains:'no-secrets'
//      — so a bug that mislabels a snapshot still cannot get it out.
//   2. A RESTORE NEEDS `confirm:true`. Not because a stray click is likely, but because the
//      plan and the apply are separate calls and an operator must have seen a plan before
//      the apply is meaningful. The UI shows the plan; this makes the sequence mandatory
//      rather than conventional.

import { indexBackups, noBackupDir, renderCommands } from './backup-index.js'
import { isDownloadable, parseEnvelope, SnapshotError } from './config-snapshot.js'

const ok = (body) => ({ status: 200, body })
const created = (body) => ({ status: 201, body })

function errStatus (err) {
  if (err instanceof SnapshotError) return err.code === 'not-found' ? 404 : err.code === 'mismatch' ? 409 : 400
  if (err && err.code === 'not-found') return 404
  if (err && err.code === 'exists') return 409
  return 400
}

// mod = the service's config-snapshot module (buildSnapshot / buildTemplate / plan / apply /
//       SECTIONS / describeResult, and optionally RESTORE_SUPPORTED + RESTORE_NOTE).
// store = makeSnapshotStore(...) for this service.
// backupsDir = where the DR archives are visible, or null when nothing is mounted.
export function makeConfigRoutes ({ service, ctx, mod, store, backupsDir = null }) {
  const restoreSupported = mod.RESTORE_SUPPORTED !== false

  // Snapshot first, ask later. Taking one is a read of files the service already owns, so
  // it is cheap enough to do before anything bulk and destructive — and the moment an
  // operator wants it, it is far too late to take.
  //
  // Wired at the ROUTE layer rather than inside the ops modules on purpose: it captures
  // "an operator is about to do something big from the dashboard", which is exactly the
  // event worth a rollback point, and it keeps this feature out of the registry writers.
  async function autoSnapshot (reason) {
    try {
      const env = await mod.buildSnapshot(ctx, { note: 'automatic — before ' + reason })
      return store.write(env)
    } catch (err) {
      // A failed auto-snapshot must never block the operation the operator actually asked
      // for. It is reported alongside the result instead.
      return { error: err.message }
    }
  }

  async function handle ({ segs, method, body = {}, query = {} }) {
    // segs excludes the leading 'api'.
    const [r1, r2, r3, r4] = segs

    // ---------------------------------------------------------------- backups (read-only)
    if (r1 === 'backups' && segs.length === 1) {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } }
      const idx = backupsDir
        ? indexBackups(backupsDir, { service })
        : noBackupDir('no backup directory is mounted into this service')
      return ok({
        ...idx,
        service,
        // The dashboards cannot MAKE or APPLY one of these. backup.sh stops the service to
        // copy its volume, and a service cannot stop itself through its own HTTP API — the
        // request dies with it. So the UI lists and explains, and the operator runs these.
        canRunHere: false,
        why: 'A disaster-recovery archive needs the service stopped while its volume is copied. This service cannot stop itself and still answer you, so these commands are run on the box.',
        commands: renderCommands({ service, archive: idx.newest ? `backups/${idx.newest.name}` : null })
      })
    }

    if (r1 !== 'config') return null

    // ---------------------------------------------------------------- capabilities
    if (segs.length === 1) {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } }
      return ok({
        service,
        sections: mod.SECTIONS,
        restoreSupported,
        ...(restoreSupported ? {} : { restoreNote: mod.RESTORE_NOTE }),
        snapshotDir: store.dir,
        // Said here so all four dashboards state it identically, and so an API consumer
        // learns it too rather than only a human reading the page.
        notes: [
          'A config snapshot holds this box\'s secrets. It stays on the box: it is never offered as a download.',
          'A config template holds no secrets. It recreates structure, NOT entitlements — grants seal the per-stream keys a template leaves out.',
          'Snapshots live in the data volume. They survive an operator mistake, not the loss of the volume. Use the disaster-recovery archive for that.',
          'No artifact here contains a .env file. Those live outside the volumes.'
        ]
      })
    }

    // ---------------------------------------------------------------- template
    if (r2 === 'template') {
      if (segs.length === 2 && method === 'GET') {
        const env = await mod.buildTemplate(ctx, { note: query.note || '' })
        // The gate, not a formality: refuse to serve anything that is not provably clean.
        if (!isDownloadable(env)) {
          return { status: 500, body: { error: 'refusing to serve this artifact: it is not a secret-free template' } }
        }
        return ok(env)
      }
      if (segs.length === 3 && r3 === 'plan' && method === 'POST') {
        const env = parseEnvelope(body.template, { service })
        return ok(await mod.plan(ctx, env, body))
      }
      if (segs.length === 3 && r3 === 'import' && method === 'POST') {
        if (!restoreSupported) return { status: 400, body: { error: mod.RESTORE_NOTE } }
        if (body.confirm !== true) return { status: 400, body: { error: 'confirm:true is required — review the plan first' } }
        const env = parseEnvelope(body.template, { service })
        const auto = await autoSnapshot('a template import')
        const result = await mod.apply(ctx, env, body)
        return ok({ result, summary: mod.describeResult(result), rollbackSnapshot: auto })
      }
    }

    // ---------------------------------------------------------------- snapshots
    if (r2 === 'snapshots') {
      if (segs.length === 2) {
        if (method === 'GET') return ok({ service, snapshots: store.list(), dir: store.dir })
        if (method === 'POST') {
          const env = await mod.buildSnapshot(ctx, { note: body.note || '' })
          const written = store.write(env)
          return created({ ...written, meta: env.meta, createdAt: env.createdAt })
        }
      }
      if (segs.length === 3 && r3) {
        if (method === 'GET') {
          // Metadata only. The contents stay in the volume — see the header.
          const env = store.read(r3)
          return ok({
            id: r3,
            service: env.service,
            kind: env.kind,
            contains: env.contains,
            createdAt: env.createdAt,
            note: env.note,
            meta: env.meta,
            sections: Object.fromEntries(Object.entries(env.sections).map(([k, v]) => [k, { entries: v && typeof v === 'object' ? Object.keys(v).length : (v == null ? 0 : 1), ...(mod.SECTIONS[k] || {}) }])),
            contentsWithheld: 'A config snapshot holds secrets and is never served over HTTP. Read it on the box if you need the values.'
          })
        }
        if (method === 'DELETE') return ok(store.remove(r3))
      }
      if (segs.length === 4 && r4 === 'plan' && method === 'POST') {
        return ok(await mod.plan(ctx, store.read(r3), body))
      }
      if (segs.length === 4 && r4 === 'restore' && method === 'POST') {
        if (!restoreSupported) return { status: 400, body: { error: mod.RESTORE_NOTE } }
        if (body.confirm !== true) return { status: 400, body: { error: 'confirm:true is required — review the plan first' } }
        const env = store.read(r3)
        // Even a restore gets a rollback point. Restoring the wrong snapshot is one of the
        // likelier ways to need one.
        const auto = await autoSnapshot('a restore from ' + r3)
        const result = await mod.apply(ctx, env, body)
        return ok({ restored: r3, result, summary: mod.describeResult(result), rollbackSnapshot: auto })
      }
    }

    return { status: 404, body: { error: 'not found' } }
  }

  return {
    autoSnapshot,
    // Wrap the throwing paths once, so four adapters do not each re-derive the mapping
    // from SnapshotError codes to HTTP status.
    async handle (req) {
      try {
        return await handle(req)
      } catch (err) {
        return { status: errStatus(err), body: { error: err.message } }
      }
    }
  }
}
