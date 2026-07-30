// Library (VOD transcoder) config snapshots and templates — see
// @aliran/core/config-snapshot.js for the envelope and why there are three artifacts.
//
// SECTIONS
//
//   titles        titles.json — the registry. Restorable, with the large caveat below.
//   titleSecrets  secrets/titles.json — per-title encryption keys. Restorable, ADD-ONLY.
//   admins        secrets/admins.json. Captured, never written back (tokenVersion rewind
//                 would un-revoke sessions — same rule as the panel and broadcaster).
//
// THE CAVEAT THAT MAKES THIS SERVICE DIFFERENT
//
// For the panel and the broadcaster, the registry IS the thing worth restoring: a channel
// is its config, and a restored channel works. For the library it is not. The runbook puts
// it plainly — the ingested titles ARE the served artifact, and re-ingesting needs the
// original files. A title's media lives in the corestore inside the data volume; no config
// artifact carries it.
//
// So a library config snapshot restores METADATA, and this module refuses to pretend
// otherwise:
//
//   - a title that still exists here gets its operational fields back (input, mode,
//     hlsTime — the only fields the store lets anything but the panel change; descriptive
//     metadata is panel-owned after creation).
//   - a title that is GONE cannot be brought back by metadata. Re-creating the registry
//     entry starts a fresh INGEST from its original input path, which is a transcode burst
//     that only works if that file is still on this box. That is opt-in (`reingestMissing`)
//     and never the default, because an operator restoring one title's settings must not
//     accidentally start fifty transcodes.
//
// For a library, the disaster-recovery archive of the whole DATA_DIR is the real answer,
// and the dashboard says so rather than implying this is equivalent.

import {
  KIND_CONFIG, KIND_TEMPLATE, makeEnvelope, applyTemplateSpec, SnapshotError
} from '@aliran/core/config-snapshot.js'
import { loadAdmins } from './control-auth.js'

export const SERVICE = 'library'

export const SECTIONS = {
  titles: { restorable: true, label: 'Title registry' },
  titleSecrets: {
    restorable: true,
    addOnly: true,
    label: 'Per-title keys',
    reason: 'Installed only for a title that has no key now. An existing key is never replaced.'
  },
  admins: {
    restorable: false,
    label: 'Control admins',
    reason: 'Captured so the snapshot is complete. It is never written back: rewinding tokenVersion would give a revoked session its access again.'
  }
}

export const TEMPLATE_SPEC = {
  drop: [
    { section: 'titleSecrets', reason: 'Per-title encryption keys.' },
    { section: 'admins', reason: 'Argon2id password verifiers.' }
  ],
  redact: [
    // A title input is a path on THAT box or a URL that can carry user:pass. Either way it
    // does not transfer, so a template records which titles a library holds and lets the
    // operator supply the sources.
    { path: 'titles.*.input', reason: 'Source path or URL — specific to the box it was ingested on, and able to carry credentials.' },
    { path: 'titles.*.feedKey', reason: "This site's swarm key for the title." },
    { path: 'titles.*.state', reason: 'Ingest state.' },
    { path: 'titles.*.error', reason: 'Ingest state.' },
    { path: 'titles.*.gen', reason: 'Feed generation — site state.' },
    { path: 'titles.*.durationSec', reason: 'Measured at ingest.' },
    { path: 'titles.*.segments', reason: 'Measured at ingest.' },
    { path: 'titles.*.bytes', reason: 'Measured at ingest.' },
    { path: 'titles.*.createdAt', reason: 'Site history.' },
    { path: 'titles.*.ingestedAt', reason: 'Site history.' }
  ]
}

function collect (ctx) {
  const titles = {}
  for (const meta of ctx.manager.titles.values()) titles[meta.id] = JSON.parse(JSON.stringify(meta))
  let titleSecrets = {}
  try { titleSecrets = ctx.manager._loadSecrets() } catch {}
  return { titles, titleSecrets, admins: loadAdmins(ctx.dataDir) }
}

function summarize (sections) {
  const t = Object.values(sections.titles || {})
  return {
    titles: t.length,
    ready: t.filter((x) => x.state === 'ready').length,
    admins: Object.keys(sections.admins || {}).length
  }
}

export function buildSnapshot (ctx, { note = '' } = {}) {
  const sections = collect(ctx)
  return makeEnvelope({ service: SERVICE, kind: KIND_CONFIG, sections, meta: summarize(sections), note })
}

export function buildTemplate (ctx, { note = '' } = {}) {
  const { sections, omitted } = applyTemplateSpec(collect(ctx), TEMPLATE_SPEC)
  return makeEnvelope({ service: SERVICE, kind: KIND_TEMPLATE, sections, omitted, meta: summarize(sections), note })
}

const UPDATE_FIELDS = ['input', 'mode', 'hlsTime']

export function plan (ctx, env, { reingestMissing = false } = {}) {
  const desired = env.sections.titles || {}
  const p = { service: SERVICE, kind: env.kind, update: [], missing: [], extra: [], warnings: [] }

  for (const [id, meta] of Object.entries(desired)) {
    const cur = ctx.manager.titles.get(id)
    if (!cur) {
      // A template deliberately has no input, so it can never start an ingest.
      const canReingest = reingestMissing && typeof meta.input === 'string' && !!meta.input
      p.missing.push({ id, willReingest: canReingest, input: meta.input || null })
      continue
    }
    const fields = UPDATE_FIELDS.filter((f) => f in meta && JSON.stringify(meta[f] ?? null) !== JSON.stringify(cur[f] ?? null))
    if (fields.length) p.update.push({ id, fields, state: cur.state })
  }
  for (const id of ctx.manager.titles.keys()) if (!(id in desired)) p.extra.push({ id })

  if (p.missing.length) {
    const re = p.missing.filter((m) => m.willReingest).length
    p.warnings.push(
      re
        ? `${re} missing title(s) will be RE-INGESTED from their original input path. That path must still hold the file on this box, and each one is a transcode job.`
        : `${p.missing.length} title(s) in the artifact are not on this box. Their media is not in a config artifact, so metadata alone cannot bring them back. Restore the data-volume archive, or re-ingest them.`
    )
  }
  if (env.kind === KIND_TEMPLATE) {
    p.warnings.push('A template holds no source paths and no keys. Use it as a list of the titles to ingest, not as a way to recreate them.')
  }
  if (p.extra.length) p.warnings.push(`${p.extra.length} title(s) on this box are not in the artifact. They are left alone — a title is deleted only from the Titles page.`)
  return p
}

export async function apply (ctx, env, { reingestMissing = false } = {}) {
  const desired = env.sections.titles || {}
  const done = { updated: [], reingested: [], skipped: [], failed: [] }
  const wantSecrets = env.sections.titleSecrets || {}
  let secrets = {}
  try { secrets = ctx.manager._loadSecrets() } catch {}
  let secretsDirty = false

  for (const [id, meta] of Object.entries(desired)) {
    const cur = ctx.manager.titles.get(id)
    if (!cur) {
      if (!reingestMissing || typeof meta.input !== 'string' || !meta.input) { done.skipped.push({ id, reason: 'not on this box' }); continue }
      try {
        // Install the key BEFORE the add, so the re-ingested title keeps the identity the
        // panel's grants were sealed against instead of minting a new one.
        if (wantSecrets[id] && !secrets[id]) { secrets[id] = wantSecrets[id]; secretsDirty = true }
        if (secretsDirty) { ctx.manager._saveSecrets(secrets); secretsDirty = false }
        await ctx.manager.add(id, { title: meta.title, description: meta.description, category: meta.category, protection: meta.protection, input: meta.input, mode: meta.mode, hlsTime: meta.hlsTime })
        done.reingested.push(id)
      } catch (err) { done.failed.push({ id, error: err.message }) }
      continue
    }
    const patch = {}
    for (const f of UPDATE_FIELDS) if (f in meta && JSON.stringify(meta[f] ?? null) !== JSON.stringify(cur[f] ?? null)) patch[f] = meta[f]
    if (!Object.keys(patch).length) continue
    try { await ctx.manager.update(id, patch); done.updated.push(id) } catch (err) { done.failed.push({ id, error: err.message }) }
  }
  if (secretsDirty) { try { ctx.manager._saveSecrets(secrets) } catch {} }
  return done
}

export function describeResult (r) {
  const parts = []
  if (r.updated.length) parts.push(`${r.updated.length} updated`)
  if (r.reingested.length) parts.push(`${r.reingested.length} queued for re-ingest`)
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`)
  if (r.failed.length) parts.push(`${r.failed.length} FAILED`)
  return parts.length ? parts.join(', ') : 'No change: this library already matches the artifact.'
}

export { SnapshotError }
