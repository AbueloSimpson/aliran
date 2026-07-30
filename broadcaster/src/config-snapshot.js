// Broadcaster config snapshots and templates — see @aliran/core/config-snapshot.js for
// the envelope, the redaction engine and why there are three artifacts rather than one.
//
// SECTIONS
//
//   channels  the channel registry (channels.json), read from the LIVE manager rather
//             than the file, so a snapshot can never capture a registry that a concurrent
//             write has already moved past. Restorable.
//   admins    secrets/admins.json — Argon2id verifiers. CAPTURED BUT NEVER RESTORED; see
//             below.
//
// WHY THE ADMIN FILE IS CAPTURED BUT NOT RESTORED
//
// It is in the snapshot because a config artifact that silently omits the credential file
// is not this box's config, and an operator who has lost the volume needs those bytes.
//
// It is never written back because rolling `tokenVersion` BACKWARDS un-revokes sessions.
// Bumping tokenVersion is the documented instant-revocation lever for a leaked admin
// token: a restore that rewinds it would hand a revoked token back its access, silently,
// as a side effect of an operator fixing an unrelated lineup mistake. Recovering an admin
// account from a snapshot is therefore a deliberate manual step (read the JSON, or just
// `control-cli add-admin` again), never a checkbox.
//
// The same reasoning covers the panel's publishers file — see panel/src/config-snapshot.js.

import {
  KIND_CONFIG, KIND_TEMPLATE, makeEnvelope, applyTemplateSpec, SnapshotError
} from '@aliran/core/config-snapshot.js'
import { loadAdmins } from './control-auth.js'

export const SERVICE = 'broadcaster'

// Sections a restore writes back, and the honest reason for the ones it will not.
export const SECTIONS = {
  channels: { restorable: true, label: 'Channel registry' },
  admins: {
    restorable: false,
    label: 'Control admins',
    reason: 'Captured so the snapshot is complete. It is never written back: an admins file holds tokenVersion, and rewinding it would give revoked sessions their access again. Add an admin again with control-cli, or read the value out of the snapshot by hand.'
  }
}

// What a TEMPLATE must not carry off this box.
//
// The three input secrets are obvious. `input.url` is the one that is easy to miss: a pull
// source is routinely `http://user:pass@host:81/NAME_123/mpegts`, so the URL itself is a
// credential. It keeps its origin and path (that is the structure worth copying) and loses
// userinfo and query.
//
// feedKey / feedGen are not secret — they are public swarm keys — but they ARE this site's
// identity. A second site that imported them would announce another deployment's feeds.
// desiredRunning and createdAt are runtime state, not structure: an imported lineup arrives
// STOPPED, which is also the safe default for a box the operator has not finished setting up.
export const TEMPLATE_SPEC = {
  drop: [
    { section: 'admins', reason: 'Argon2id password verifiers — a template is a downloadable file.' }
  ],
  redact: [
    { path: 'channels.*.input.streamKey', reason: 'Push stream key — the credential an encoder authenticates with.' },
    { path: 'channels.*.input.passphrase', reason: 'SRT passphrase — real transport authentication.' },
    { path: 'channels.*.input.cencKey', reason: 'CENC decryption key for the pull source.' },
    { path: 'channels.*.input.url', mode: 'url', reason: 'Pull source URL — user:pass and query parameters removed, origin and path kept.' },
    { path: 'channels.*.feedKey', reason: "This site's swarm identity for the channel. A second site mints its own." },
    { path: 'channels.*.feedGen', reason: 'Feed generation counter — site state.' },
    { path: 'channels.*.desiredRunning', reason: 'Run state. Imported channels arrive stopped.' },
    { path: 'channels.*.createdAt', reason: 'Site history.' }
  ]
}

// ---------------------------------------------------------------- collect

function collect (ctx, { includeLegacy = true } = {}) {
  const channels = {}
  for (const [id, ch] of ctx.manager.channels) {
    // The env-configured legacy channel is refreshed from broadcaster/.env on every boot,
    // so it is not registry-owned config. It stays in a snapshot (which describes this box
    // exactly) and leaves a template (which describes a lineup).
    if (!includeLegacy && ch.meta.legacy) continue
    channels[id] = JSON.parse(JSON.stringify(ch.meta))
  }
  return { channels, admins: loadAdmins(ctx.dataDir) }
}

function summarize (sections) {
  const chans = Object.values(sections.channels || {})
  const push = chans.filter((c) => c.input && (c.input.kind === 'rtmp' || c.input.kind === 'srt' || c.input.kind === 'udp')).length
  return {
    channels: chans.length,
    pushChannels: push,
    running: chans.filter((c) => c.desiredRunning).length,
    admins: Object.keys(sections.admins || {}).length
  }
}

export function buildSnapshot (ctx, { note = '' } = {}) {
  const sections = collect(ctx)
  return makeEnvelope({ service: SERVICE, kind: KIND_CONFIG, sections, meta: summarize(sections), note })
}

export function buildTemplate (ctx, { note = '' } = {}) {
  const raw = collect(ctx, { includeLegacy: false })
  const { sections, omitted } = applyTemplateSpec(raw, TEMPLATE_SPEC)
  return makeEnvelope({ service: SERVICE, kind: KIND_TEMPLATE, sections, omitted, meta: summarize(sections), note })
}

// ---------------------------------------------------------------- plan / apply
//
// Restore and import are the same diff against the live registry — a template is simply a
// snapshot with fields missing — so one planner serves both and the envelope's kind decides
// how the result is described.
//
// The diff is ADDITIVE AND UPDATING by default; channels the artifact does not mention are
// left alone and reported as `extra`. That default matters: the common case is "I deleted a
// channel by mistake", and an operator fixing one channel must not silently lose the ten
// they legitimately added after the snapshot was taken. Removal is opt-in (removeExtra) and
// still obeys the manager's own rule that a running channel is stopped first.

const RESTORE_FIELDS = ['title', 'description', 'category', 'input', 'transcode', 'ingestTuning', 'buffer', 'hls']

function differingFields (desired, current) {
  const out = {}
  for (const f of RESTORE_FIELDS) {
    if (!(f in desired)) continue
    // hls is stored as {time,listSize}; everything else compares fine by value.
    if (JSON.stringify(desired[f] ?? null) !== JSON.stringify(current[f] ?? null)) out[f] = desired[f]
  }
  return out
}

export function plan (ctx, env, { removeExtra = false } = {}) {
  const desired = env.sections.channels || {}
  const isTemplate = env.kind === KIND_TEMPLATE
  const add = []
  const update = []
  const extra = []
  const warnings = []

  for (const [id, meta] of Object.entries(desired)) {
    const ch = ctx.manager.channels.get(id)
    if (!ch) {
      add.push({ id, title: meta.title || id, input: meta.input ? meta.input.kind : 'test' })
      continue
    }
    const diff = differingFields(meta, ch.meta)
    if (Object.keys(diff).length) {
      update.push({ id, fields: Object.keys(diff), running: !!ch.run, restartRequired: !!ch.run })
    }
  }
  for (const [id, ch] of ctx.manager.channels) {
    if (id in desired) continue
    if (ch.meta.legacy) continue // env-owned, never registry-owned
    extra.push({ id, running: !!ch.run, willRemove: removeExtra })
    if (removeExtra && ch.run) warnings.push(`"${id}" is running and will be stopped before it is removed.`)
  }

  if (isTemplate) {
    const pushAdds = add.filter((a) => a.input === 'rtmp' || a.input === 'srt')
    if (pushAdds.length) {
      warnings.push(`${pushAdds.length} push channel(s) get a NEW stream key, because a template does not carry one. Give the new key to each encoder.`)
    }
    warnings.push('Imported channels arrive stopped. Start them when the sources are ready.')
  }
  if (!removeExtra && extra.length) {
    warnings.push(`${extra.length} channel(s) on this box are not in the artifact. They are LEFT ALONE. Select "remove" only if you want the registry to match the artifact exactly.`)
  }

  return { service: SERVICE, kind: env.kind, add, update, extra, warnings, unchanged: Object.keys(desired).length - add.length - update.length }
}

export async function apply (ctx, env, opts = {}) {
  const { removeExtra = false } = opts
  const desired = env.sections.channels || {}
  const done = { added: [], updated: [], removed: [], failed: [] }

  for (const [id, meta] of Object.entries(desired)) {
    const ch = ctx.manager.channels.get(id)
    try {
      if (!ch) {
        const fields = {}
        for (const f of RESTORE_FIELDS) if (f in meta) fields[f] = meta[f]
        // hls arrives as {time,listSize}; add() takes the flat pair.
        if (meta.hls) { fields.hlsTime = meta.hls.time; fields.hlsListSize = meta.hls.listSize; delete fields.hls }
        await ctx.manager.add(id, fields)
        done.added.push(id)
      } else {
        const diff = differingFields(meta, ch.meta)
        if (!Object.keys(diff).length) continue
        if (diff.hls) { diff.hlsTime = diff.hls.time; diff.hlsListSize = diff.hls.listSize; delete diff.hls }
        const r = await ctx.manager.update(id, diff)
        done.updated.push({ id, restartRequired: !!r.restartRequired })
      }
    } catch (err) {
      done.failed.push({ id, error: err.message })
    }
  }

  if (removeExtra) {
    for (const [id, ch] of [...ctx.manager.channels]) {
      if (id in desired || ch.meta.legacy) continue
      try {
        if (ch.run) await ctx.manager.stop(id)
        await ctx.manager.remove(id)
        done.removed.push(id)
      } catch (err) {
        done.failed.push({ id, error: err.message })
      }
    }
  }

  return done
}

// A restore that touched nothing is worth saying out loud rather than reporting success —
// an operator who picked the wrong artifact should learn that immediately.
export function describeResult (r) {
  const n = r.added.length + r.updated.length + r.removed.length
  if (!n && !r.failed.length) return 'No change: the registry already matches the artifact.'
  const parts = []
  if (r.added.length) parts.push(`${r.added.length} added`)
  if (r.updated.length) parts.push(`${r.updated.length} updated`)
  if (r.removed.length) parts.push(`${r.removed.length} removed`)
  if (r.failed.length) parts.push(`${r.failed.length} FAILED`)
  return parts.join(', ')
}

export { SnapshotError }
