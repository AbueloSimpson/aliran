// Panel config snapshots and templates — see @aliran/core/config-snapshot.js for the
// envelope, the redaction engine and why there are three artifacts rather than one.
//
// SECTIONS
//
//   streams        the catalog (Hyperbee `catalog/`). Restorable.
//   categories     the presentation vocabulary (`catmeta/`). Restorable.
//   packages       packages.json. Restorable.
//   sources        sources.json. Restorable.
//   vod            the external VOD provider record. Restorable.
//   streamSecrets  secrets/streams.json — the per-stream keys user grants SEAL against.
//                  Restorable, but ADD-ONLY; see below.
//   admins         secrets/admins.json. Captured, never written back.
//   publishers     secrets/publishers.json. Captured, never written back.
//
// WHAT IS NOT HERE, AND WHY
//
//   keys/          the signing keypair and the OPRF key. They are the deployment's
//                  IDENTITY, not its config: every client pins the public key, and they
//                  cannot be rotated in place. They belong in the disaster-recovery
//                  archive, which stays on the box and encrypted — never in an artifact a
//                  dashboard hands out. A config snapshot is not a substitute for that
//                  archive and the UI says so.
//   users/grants   accounts are data, not config. A snapshot that rewound the user list
//                  would delete accounts created since it was taken.
//
// WHY streamSecrets IS ADD-ONLY
//
// A user's grant is the stream key SEALED to that user. The live key is the one every
// existing grant was sealed with. Writing an older key back over it would leave every
// grant sealed to a key the panel no longer holds — the exact failure the whole artifact
// exists to prevent. So a restore installs a key only where there is NO key for that
// stream id (the deleted-and-recreated case, which is the one that needs it), and reports
// every id where it declined to overwrite.
//
// WHY admins AND publishers ARE CAPTURED BUT NEVER RESTORED
//
// Both carry a revocation lever, and a restore rewinds levers:
//
//   - an admin record's `tokenVersion` is bumped to kill every session issued under a
//     leaked token. Rewinding it hands that token its access back.
//   - a publisher's `status:'revoked'` is the documented response to a leaked broadcaster
//     box. Rewinding it re-enables the compromised key to register channels.
//
// Neither should ever happen as a side effect of an operator fixing a lineup. They are in
// the snapshot so it is genuinely complete, and recovering one is a deliberate manual step.

import {
  KIND_CONFIG, KIND_TEMPLATE, makeEnvelope, applyTemplateSpec, SnapshotError
} from '@aliran/core/config-snapshot.js'
import * as ops from './ops.js'
import * as sources from './sources.js'
import * as packages from './packages.js'
import { loadSecrets } from './store.js'

export const SERVICE = 'panel'

export const SECTIONS = {
  streams: { restorable: true, label: 'Catalog channels' },
  categories: { restorable: true, label: 'Categories' },
  packages: { restorable: true, label: 'Channel packages' },
  sources: { restorable: true, label: 'Remote sources' },
  vod: { restorable: true, label: 'VOD provider' },
  streamSecrets: {
    restorable: true,
    addOnly: true,
    label: 'Per-stream keys',
    reason: 'Installed only for a stream that has no key now. An existing key is never replaced, because every user grant is sealed against it.'
  },
  admins: {
    restorable: false,
    label: 'Dashboard admins',
    reason: 'Captured so the snapshot is complete. It is never written back: rewinding tokenVersion would give a revoked admin token its access again.'
  },
  publishers: {
    restorable: false,
    label: 'Publisher identities',
    reason: "Captured so the snapshot is complete. It is never written back: rewinding a publisher's status would re-enable a key you revoked."
  }
}

// A template is downloadable, so everything that is a secret or an identity leaves it.
//
// `sources.*.url` is the subtle one. sources.js calls its registry "plain — nothing secret
// in it", and structurally that is true, but normSourceUrl validates scheme and length and
// does NOT reject userinfo or a query string. `https://user:pass@host/feed.json?token=…` is
// a URL an operator can configure today, so the template treats every source URL as
// possibly credential-bearing: origin and path stay, userinfo and query go.
export const TEMPLATE_SPEC = {
  drop: [
    { section: 'streamSecrets', reason: 'Per-stream encryption keys. This is why an imported lineup has no entitlements.' },
    { section: 'admins', reason: 'Argon2id password verifiers.' },
    { section: 'publishers', reason: 'Publisher secret keys — each one can register channels into a catalog.' }
  ],
  redact: [
    { path: 'sources.*.url', mode: 'url', reason: 'Provider feed URL — user:pass and query parameters removed, origin and path kept.' },
    { path: 'streams.*.feedKey', reason: "This site's swarm key for the channel. A second site mints its own." },
    { path: 'streams.*.blobsKey', reason: 'Derived from feedKey.' },
    { path: 'streams.*.isLive', reason: 'Run state.' },
    { path: 'streams.*.status', reason: 'Run state.' },
    { path: 'sources.*.etag', reason: 'Sync bookkeeping for this box.' },
    { path: 'sources.*.lastSync', reason: 'Sync bookkeeping for this box.' },
    { path: 'sources.*.lastError', reason: 'Sync bookkeeping for this box.' },
    { path: 'sources.*.lastReport', reason: 'Sync bookkeeping for this box.' }
  ]
}

// ---------------------------------------------------------------- collect

async function collect (ctx) {
  const streams = {}
  for (const s of await ops.listStreams(ctx)) {
    const { id, ...rest } = s
    streams[id] = rest
  }
  const categories = {}
  for (const c of await ops.listCategories(ctx)) {
    // `channels` is a live count, not config — a snapshot that carried it would compare
    // unequal on every restore for a reason that has nothing to do with the category.
    if (!c.registered) continue
    categories[c.slug] = { label: c.label, parent: c.parent, order: c.order, hidden: c.hidden, ownedBy: c.ownedBy }
  }
  return {
    streams,
    categories,
    packages: packages.loadPackages(ctx.dataDir),
    sources: sources.loadSources(ctx.dataDir),
    vod: (await ops.getVodConfig(ctx)) || null,
    streamSecrets: loadSecrets(ctx.dataDir),
    admins: ops.loadAdmins(ctx.dataDir),
    publishers: ops.loadPublishers(ctx.dataDir)
  }
}

function summarize (sections) {
  const streams = Object.values(sections.streams || {})
  return {
    streams: streams.length,
    redirectChannels: streams.filter((s) => s.redirect).length,
    sourceOwned: streams.filter((s) => s.source).length,
    categories: Object.keys(sections.categories || {}).length,
    packages: Object.keys(sections.packages || {}).length,
    sources: Object.keys(sections.sources || {}).length,
    admins: Object.keys(sections.admins || {}).length,
    publishers: Object.keys(sections.publishers || {}).length,
    vodEnabled: !!(sections.vod && sections.vod.enabled)
  }
}

export async function buildSnapshot (ctx, { note = '' } = {}) {
  const sections = await collect(ctx)
  return makeEnvelope({ service: SERVICE, kind: KIND_CONFIG, sections, meta: summarize(sections), note })
}

export async function buildTemplate (ctx, { note = '' } = {}) {
  const raw = await collect(ctx)
  const { sections, omitted } = applyTemplateSpec(raw, TEMPLATE_SPEC)
  return makeEnvelope({ service: SERVICE, kind: KIND_TEMPLATE, sections, omitted, meta: summarize(sections), note })
}

// ---------------------------------------------------------------- plan / apply
//
// One planner for both artifacts (a template is a snapshot with fields missing), and the
// same additive default as the broadcaster: entries the artifact does not mention are LEFT
// ALONE and reported. Removing things is opt-in per section.
//
// Two panel-specific rules:
//
//   - SOURCE-OWNED CHANNELS ARE SKIPPED. A channel stamped `source:<name>` belongs to that
//     source's sync, which may only create, update or delete entries carrying its own name.
//     Restoring one by hand would produce an entry the next sync immediately rewrites or
//     removes. The fix for a missing source channel is a sync, and the plan says so.
//   - EVERY WRITE IS COMPARED FIRST. The catalog is an append-only Hyperbee with no
//     compaction, so a no-op put is permanent growth in every replica. The planner already
//     computes the diff; apply only writes what the diff found.

const STREAM_FIELDS = [
  'title', 'description', 'category', 'feedKey', 'poster', 'backdrop', 'logo',
  'order', 'featured', 'restricted', 'epgUrl', 'epgId', 'url', 'headers'
]

function streamDiff (desired, current) {
  const out = {}
  for (const f of STREAM_FIELDS) {
    if (!(f in desired)) continue
    if (JSON.stringify(desired[f] ?? null) !== JSON.stringify(current[f] ?? null)) out[f] = desired[f]
  }
  return out
}

// The identity of each non-stream section, for "has this actually changed?".
//
// plan() and apply() MUST agree, so they call the same functions. When they did not, apply
// rewrote every package and source unconditionally: it reported changes the plan had
// correctly called none, and each rewrite dragged a full package reconcile behind it.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const catShape = (c) => [c.label, c.order ?? null, !!c.hidden]
const pkgShape = (p) => [p.label, p.members, !!p.default]

const SOURCE_FIELDS = ['url', 'category', 'prefix', 'autoGrant', 'enabled', 'intervalMs', 'exclude', 'format', 'groups']

// Sources diff PER FIELD, exactly like streamDiff and for the same reason: an artifact
// written before a field existed does not MENTION that field, and "not mentioned" has to
// mean "leave it alone" — never "reset it to the default". A whole-shape comparison
// cannot tell those apart, so a pre-M3U snapshot restored over an m3u source would report
// a phantom change and then really apply it, turning a working playlist source into a
// json one that fails its next sync. Returning the diff (not a boolean) is also what
// keeps plan and apply honest: apply writes exactly the fields the plan counted.
function sourceDiff (desired, current) {
  const out = {}
  for (const f of SOURCE_FIELDS) {
    if (!(f in desired)) continue
    if (JSON.stringify(desired[f] ?? null) !== JSON.stringify(current[f] ?? null)) out[f] = desired[f]
  }
  return out
}

export async function plan (ctx, env, opts = {}) {
  const { removeExtra = false, sections: only = null } = opts
  const want = (name) => (!only || only.includes(name)) && !!env.sections[name]
  const isTemplate = env.kind === KIND_TEMPLATE

  const live = {}
  for (const s of await ops.listStreams(ctx)) live[s.id] = s
  const liveSecrets = loadSecrets(ctx.dataDir)
  const livePackages = packages.loadPackages(ctx.dataDir)
  const liveSources = sources.loadSources(ctx.dataDir)
  const liveCats = {}
  for (const c of await ops.listCategories(ctx)) if (c.registered) liveCats[c.slug] = c

  const p = { service: SERVICE, kind: env.kind, streams: { add: [], update: [], extra: [], skipped: [] }, categories: { add: [], update: [] }, packages: { add: [], update: [], extra: [] }, sources: { add: [], update: [], extra: [] }, vod: null, secrets: { install: [], declined: [] }, warnings: [] }

  if (want('streams')) {
    for (const [id, meta] of Object.entries(env.sections.streams)) {
      if (meta.source) { p.streams.skipped.push({ id, reason: `owned by source "${meta.source}" — run that source's sync to recreate it` }); continue }
      const cur = live[id]
      if (!cur) {
        p.streams.add.push({ id, title: meta.title || id, redirect: !!meta.redirect })
        if (want('streamSecrets') && env.sections.streamSecrets && env.sections.streamSecrets[id]) p.secrets.install.push(id)
      } else {
        const d = streamDiff(meta, cur)
        if (Object.keys(d).length) p.streams.update.push({ id, fields: Object.keys(d) })
        if (want('streamSecrets') && env.sections.streamSecrets && env.sections.streamSecrets[id] && liveSecrets[id] && liveSecrets[id] !== env.sections.streamSecrets[id]) {
          p.secrets.declined.push(id)
        }
      }
    }
    for (const id of Object.keys(live)) {
      if (id in env.sections.streams) continue
      if (live[id].source) continue // a source owns it; not the artifact's business
      p.streams.extra.push({ id, willRemove: removeExtra })
    }
  }

  if (want('categories')) {
    for (const [slug, c] of Object.entries(env.sections.categories)) {
      const cur = liveCats[slug]
      if (!cur) p.categories.add.push(slug)
      else if (!same(catShape(c), catShape(cur))) p.categories.update.push(slug)
    }
  }

  if (want('packages')) {
    for (const [name, pk] of Object.entries(env.sections.packages)) {
      const cur = livePackages[name]
      if (!cur) p.packages.add.push(name)
      else if (!same(pkgShape(pk), pkgShape(cur))) p.packages.update.push(name)
    }
    for (const name of Object.keys(livePackages)) if (!(name in env.sections.packages)) p.packages.extra.push({ name, willRemove: removeExtra })
  }

  if (want('sources')) {
    for (const [name, s] of Object.entries(env.sections.sources)) {
      const cur = liveSources[name]
      if (!cur) p.sources.add.push(name)
      else if (Object.keys(sourceDiff(s, cur)).length) p.sources.update.push(name)
    }
    for (const name of Object.keys(liveSources)) if (!(name in env.sections.sources)) p.sources.extra.push({ name, willRemove: removeExtra })
  }

  if (want('vod') && env.sections.vod) {
    const cur = await ops.getVodConfig(ctx)
    if (JSON.stringify(cur) !== JSON.stringify(env.sections.vod)) p.vod = { change: true, enabled: !!env.sections.vod.enabled }
  }

  // ---- the honesty block ----
  if (isTemplate) {
    p.warnings.push('A template carries NO per-stream keys, so the channels it creates have NO entitlements. Nobody can watch them until you grant access — by package or by hand.')
    if (p.sources.add.length) p.warnings.push(`${p.sources.add.length} source URL(s) lost their user:pass and query parameters when the template was made. Re-enter them before you enable the source.`)
  }
  if (p.secrets.declined.length) {
    p.warnings.push(`${p.secrets.declined.length} stream(s) already have a different key. The key in the artifact is NOT installed for them, because every existing grant is sealed against the key that is there now.`)
  }
  if (p.streams.skipped.length) {
    p.warnings.push(`${p.streams.skipped.length} channel(s) belong to a remote source and are skipped. Run that source's sync to recreate them.`)
  }
  if (!removeExtra && (p.streams.extra.length || p.packages.extra.length || p.sources.extra.length)) {
    p.warnings.push('Entries that exist here but not in the artifact are LEFT ALONE. Select "remove" only if you want an exact match.')
  }
  if (removeExtra && p.streams.extra.length) {
    p.warnings.push(`Removing ${p.streams.extra.length} channel(s) is a FULL purge: art, every user's sealed grant, and the per-stream key. Re-adding the id later mints a new key.`)
  }
  return p
}

export async function apply (ctx, env, opts = {}) {
  const { removeExtra = false, sections: only = null } = opts
  const want = (name) => (!only || only.includes(name)) && !!env.sections[name]
  const done = { streams: { added: [], updated: [], removed: [] }, categories: [], packages: [], sources: [], vod: false, secretsInstalled: [], secretsDeclined: [], skipped: [], failed: [] }

  // Categories first: a channel can carry a category slug, and registering the vocabulary
  // before the members means the dashboard never shows a rail with no label mid-restore.
  if (want('categories')) {
    const liveCats = {}
    for (const c of await ops.listCategories(ctx)) if (c.registered) liveCats[c.slug] = c
    for (const [slug, c] of Object.entries(env.sections.categories)) {
      if (liveCats[slug] && same(catShape(c), catShape(liveCats[slug]))) continue
      try {
        await ops.upsertCategory(ctx, slug, { label: c.label, order: c.order, hidden: c.hidden, ownedBy: c.ownedBy })
        done.categories.push(slug)
      } catch (err) { done.failed.push({ section: 'categories', id: slug, error: err.message }) }
    }
  }

  if (want('streams')) {
    const live = {}
    for (const s of await ops.listStreams(ctx)) live[s.id] = s
    const liveSecrets = loadSecrets(ctx.dataDir)
    const wantSecrets = want('streamSecrets') ? (env.sections.streamSecrets || {}) : {}

    for (const [id, meta] of Object.entries(env.sections.streams)) {
      if (meta.source) { done.skipped.push({ id, reason: 'source-owned' }); continue }
      try {
        if (!live[id]) {
          const optsAdd = {}
          for (const f of STREAM_FIELDS) if (meta[f] != null) optsAdd[f] = meta[f]
          // The key rides in on creation, which is the only moment it can be set without
          // stranding a grant. addStream mints a fresh one when none is supplied.
          if (wantSecrets[id]) { optsAdd.key = wantSecrets[id]; done.secretsInstalled.push(id) }
          await ops.addStream(ctx, id, optsAdd)
          done.streams.added.push(id)
        } else {
          if (wantSecrets[id] && liveSecrets[id] && liveSecrets[id] !== wantSecrets[id]) done.secretsDeclined.push(id)
          const d = streamDiff(meta, live[id])
          if (!Object.keys(d).length) continue
          await ops.setMeta(ctx, id, d)
          done.streams.updated.push(id)
        }
      } catch (err) { done.failed.push({ section: 'streams', id, error: err.message }) }
    }

    if (removeExtra) {
      for (const id of Object.keys(live)) {
        if (id in env.sections.streams || live[id].source) continue
        try { await ops.deleteStream(ctx, id); done.streams.removed.push(id) } catch (err) { done.failed.push({ section: 'streams', id, error: err.message }) }
      }
    }
  }

  if (want('packages')) {
    const livePackages = packages.loadPackages(ctx.dataDir)
    for (const [name, pk] of Object.entries(env.sections.packages)) {
      // Unchanged packages are SKIPPED, not rewritten: setPackage runs a full
      // reconcilePackages over every holder, which is real work for no change.
      if (livePackages[name] && same(pkgShape(pk), pkgShape(livePackages[name]))) continue
      try {
        if (!livePackages[name]) await packages.addPackage(ctx, name, { label: pk.label, members: pk.members, default: pk.default })
        else await packages.setPackage(ctx, name, { label: pk.label, members: pk.members, default: pk.default })
        done.packages.push(name)
      } catch (err) { done.failed.push({ section: 'packages', id: name, error: err.message }) }
    }
    if (removeExtra) {
      for (const name of Object.keys(livePackages)) {
        if (name in env.sections.packages) continue
        try { await packages.removePackage(ctx, name); done.packages.push('-' + name) } catch (err) { done.failed.push({ section: 'packages', id: name, error: err.message }) }
      }
    }
  }

  if (want('sources')) {
    const liveSources = sources.loadSources(ctx.dataDir)
    for (const [name, s] of Object.entries(env.sections.sources)) {
      const cur = liveSources[name]
      // A CREATE takes every field the artifact carries (addSource needs url + category,
      // and defaults whatever the artifact predates). An UPDATE writes only the diff the
      // plan just counted — same discipline as streams, and the reason a pre-M3U artifact
      // cannot silently downgrade an m3u source it never knew about.
      const d = cur ? sourceDiff(s, cur) : null
      if (d && !Object.keys(d).length) continue
      try {
        if (!cur) {
          sources.addSource(ctx, name, { url: s.url, category: s.category, prefix: s.prefix, autoGrant: s.autoGrant, enabled: s.enabled, intervalMs: s.intervalMs, exclude: s.exclude, format: s.format, groups: s.groups })
        } else {
          sources.setSource(ctx, name, d)
        }
        done.sources.push(name)
      } catch (err) { done.failed.push({ section: 'sources', id: name, error: err.message }) }
    }
    if (removeExtra) {
      for (const name of Object.keys(liveSources)) {
        if (name in env.sections.sources) continue
        try { await sources.removeSource(ctx, name); done.sources.push('-' + name) } catch (err) { done.failed.push({ section: 'sources', id: name, error: err.message }) }
      }
    }
  }

  if (want('vod') && env.sections.vod) {
    try { await ops.setVodConfig(ctx, env.sections.vod); done.vod = true } catch (err) { done.failed.push({ section: 'vod', error: err.message }) }
  }

  return done
}

export function describeResult (r) {
  const parts = []
  if (r.streams.added.length) parts.push(`${r.streams.added.length} channels added`)
  if (r.streams.updated.length) parts.push(`${r.streams.updated.length} channels updated`)
  if (r.streams.removed.length) parts.push(`${r.streams.removed.length} channels removed`)
  if (r.categories.length) parts.push(`${r.categories.length} categories`)
  if (r.packages.length) parts.push(`${r.packages.length} packages`)
  if (r.sources.length) parts.push(`${r.sources.length} sources`)
  if (r.vod) parts.push('VOD provider')
  if (r.failed.length) parts.push(`${r.failed.length} FAILED`)
  return parts.length ? parts.join(', ') : 'No change: this panel already matches the artifact.'
}

export { SnapshotError }
