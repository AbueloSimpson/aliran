// Config snapshots and config templates — the two artifacts a service CAN produce for
// itself, and the redaction engine that keeps them apart.
//
// NOT re-exported from index.js on purpose (same reason as net-tune.js, store-gc.js and
// atomic-write.js): this module touches the filesystem and is server-side only, while
// index.js is bundled into the Bare worklet. Import it by path:
//   import { makeSnapshotStore, buildTemplate } from '@aliran/core/config-snapshot.js'
//
// THREE ARTIFACTS, AND WHY THIS FILE ONLY MAKES TWO OF THEM
//
// An operator wants three different things from "back up my config", and one file cannot
// be all three without being wrong for two of them:
//
//   1. DISASTER-RECOVERY ARCHIVE — the whole DATA_DIR, identity and all. It needs a COLD
//      stop (a corestore copied mid-write can capture a torn tree), so a service cannot
//      make one through its own HTTP API: stopping the service kills the request that
//      asked for it. That artifact stays with deploy/backup.sh; see backup-index.js for
//      the read-only listing side the dashboards do offer.
//   2. CONFIG SNAPSHOT (KIND_CONFIG) — this box's exact config INCLUDING its secrets.
//      The undo-a-bad-change artifact. A plain read of files the service already owns.
//   3. CONFIG TEMPLATE (KIND_TEMPLATE) — the same structure with every secret STRIPPED.
//      Portable: seed a second site, version a lineup, diff what changed.
//
// WHY THE SNAPSHOT KEEPS ITS SECRETS
//
// It is tempting to make one artifact and strip secrets from it "to be safe". That builds
// a restore that reports success and delivers a broken service:
//
//   - broadcaster channels.json holds each push channel's stream key and SRT passphrase.
//     Restore a stripped copy and the channel comes back with a NEW stream key, so every
//     encoder in the field is still pointing at the old one and stops working.
//   - panel secrets/streams.json holds the per-stream keys that user grants SEAL against.
//     Strip those and every existing grant is worthless.
//
// So KIND_CONFIG carries the secrets, and the handling rules follow from that: it lives
// ON THE BOX at 0600 and is never offered as a browser download. KIND_TEMPLATE is safe to
// download precisely because it carries nothing sensitive — and `contains` states which
// one you are holding, so callers never have to infer it from the filename.
//
// WHAT A TEMPLATE COSTS YOU
//
// A template recreates STRUCTURE (channels, packages, categories, sources) but NOT
// ENTITLEMENTS, because grants seal the per-stream keys it deliberately omits. Importing
// one gives a working lineup that nobody is yet entitled to. Callers must say this out
// loud in the UI — the `omitted` list in the envelope is there so the artifact itself
// carries the explanation, not just the dashboard that made it.
//
// REDACTION IS DELETION, NOT MASKING
//
// A redacted field is REMOVED, never replaced with "***" or "REDACTED". A placeholder is
// a string, and a string can be imported as if it were real: a channel whose streamKey is
// literally "REDACTED" is worse than one with no streamKey at all, because the second case
// makes the importer mint a fresh key while the first quietly configures nonsense. The one
// exception is `mode:'url'`, which keeps the origin and path (that IS the structure) and
// drops only the credential-bearing parts.

import fs from 'fs'
import path from 'path'
// A snapshot is written 0600 in a 0700 directory, and a reader must never see a
// half-written one — the same tmp + fsync + rename recipe every registry in the tree uses.
import { writeJsonAtomic } from './atomic-write.js'

export const SNAPSHOT_FORMAT = 1

export const KIND_CONFIG = 'config'
export const KIND_TEMPLATE = 'template'

// The value of `contains`. Machine-checkable, so a download route can refuse anything
// that is not CONTAINS_NONE without re-deriving the rule from the kind.
export const CONTAINS_SECRETS = 'secrets'
export const CONTAINS_NONE = 'no-secrets'

const SERVICES = ['panel', 'broadcaster', 'library', 'reseller']

export class SnapshotError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'SnapshotError'
    this.code = code // 'bad-request' | 'not-found' | 'mismatch'
  }
}

const bad = (m) => { throw new SnapshotError('bad-request', m) }

// ---------------------------------------------------------------- URL credentials
//
// Two URL fields in the tree are operator-supplied and can carry a credential even
// though the registries holding them are described as non-secret:
//
//   panel sources[].url        — the provider feed. normSourceUrl enforces https and a
//                                length cap, but NOT the absence of userinfo or a query
//                                string, so `https://u:p@host/feed.json?token=…` is a
//                                URL an operator can legitimately configure today.
//   broadcaster input.url      — pull sources routinely look like
//                                `http://user:pass@host:81/NAME_123/mpegts`.
//
// A template keeps origin + path (that is the structure worth copying) and drops
// userinfo and the query string. The fragment goes too — it is never load-bearing here
// and is a cheap place to hide a token.
export function redactUrlCredentials (raw) {
  const s = String(raw ?? '')
  if (!s) return s
  let u
  try { u = new URL(s) } catch { return '' } // unparseable: drop it rather than guess
  // Every part we strip has to count here. Missing one (the fragment did, once) makes the
  // function return the ORIGINAL string on the exact input it was supposed to clean.
  const changed = !!(u.username || u.password || u.search || u.hash)
  u.username = ''
  u.password = ''
  u.search = ''
  u.hash = ''
  // A URL with nothing sensitive comes back byte-identical, so a template diff does not
  // churn on every clean URL just because it passed through here.
  return changed ? u.toString() : s
}

// ---------------------------------------------------------------- path matching
//
// Spec paths are dot-separated with `*` matching exactly ONE key or array index:
//   'channels.*.input.streamKey'   every channel's push key
//   'sources.*.url'                every source's feed URL
// One level per `*` on purpose — a recursive wildcard would make it impossible to read a
// spec and know what it covers, and these specs are the security boundary.

function walkPath (root, segments, visit) {
  const step = (node, i, trail) => {
    if (node == null || typeof node !== 'object') return
    const seg = segments[i]
    const last = i === segments.length - 1
    const keys = seg === '*' ? Object.keys(node) : (Object.prototype.hasOwnProperty.call(node, seg) ? [seg] : [])
    for (const k of keys) {
      if (last) visit(node, k, trail.concat(k))
      else step(node[k], i + 1, trail.concat(k))
    }
  }
  step(root, 0, [])
}

// ---------------------------------------------------------------- template spec
//
// A spec is declarative so it can be read as a list of promises:
//   drop:   [{ section, reason }]                whole sections a template never carries
//   redact: [{ path, reason, mode? }]            field-level; mode 'url' keeps origin+path
//
// Anything not named here SURVIVES into the template. That default is deliberate: a spec
// that had to enumerate what to keep would silently start leaking the moment someone added
// a field. The test (test:admin-api / test:broadcaster-api) closes the loop by seeding real
// secrets and asserting none of those bytes appear anywhere in the export — so a new secret
// field that nobody added to a spec fails CI rather than shipping.
export function applyTemplateSpec (sections, spec = {}) {
  const out = JSON.parse(JSON.stringify(sections))
  const omitted = []

  for (const { section, reason } of spec.drop || []) {
    if (!(section in out)) continue
    delete out[section]
    omitted.push({ path: section, reason, kind: 'section' })
  }

  for (const { path: p, reason, mode } of spec.redact || []) {
    const segments = String(p).split('.')
    let hits = 0
    walkPath(out, segments, (node, key) => {
      const val = node[key]
      if (mode === 'url') {
        // null/absent has nothing to keep; a clean URL keeps its exact original text.
        const cleaned = val == null ? '' : redactUrlCredentials(val)
        if (cleaned === val) return
        if (cleaned) node[key] = cleaned
        else delete node[key]
      } else {
        // Delete whenever the key is PRESENT, including when it holds null. Skipping nulls
        // would make a template's shape depend on the state of the box it came from — one
        // channel carrying `feedKey: null` and another carrying nothing — which is noise in
        // exactly the diff a template exists to support. A redacted path is simply absent.
        delete node[key]
      }
      hits++
    })
    if (hits) omitted.push({ path: p, reason, kind: mode === 'url' ? 'redacted' : 'removed', count: hits })
  }

  return { sections: out, omitted }
}

// ---------------------------------------------------------------- envelope

// `sections` is a plain object of named blocks — the caller decides the names, this module
// only carries them. `meta` is free-form service context (counts, versions) shown in the UI
// before an operator commits to a restore.
export function makeEnvelope ({ service, kind, sections, omitted = [], meta = {}, note = '' }) {
  if (!SERVICES.includes(service)) bad(`unknown service "${service}"`)
  if (kind !== KIND_CONFIG && kind !== KIND_TEMPLATE) bad(`unknown kind "${kind}"`)
  return {
    aliranSnapshot: SNAPSHOT_FORMAT,
    kind,
    service,
    contains: kind === KIND_CONFIG ? CONTAINS_SECRETS : CONTAINS_NONE,
    createdAt: new Date().toISOString(),
    note: String(note || '').slice(0, 500),
    meta,
    // Present on templates, empty on snapshots. The artifact explains its own gaps so an
    // operator reading the raw file — months later, on another box — sees why a lineup
    // imported from it has no entitlements.
    omitted,
    sections
  }
}

// Validate an artifact BEFORE anything acts on it. Returns the parsed envelope.
// `expect.service` and `expect.kind` are the caller's contract; a mismatch is a distinct
// error code so the route can answer 409 rather than a vague 400.
export function parseEnvelope (input, expect = {}) {
  let env = input
  if (typeof input === 'string') {
    try { env = JSON.parse(input) } catch { bad('not valid JSON') }
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) bad('not an object')
  if (env.aliranSnapshot !== SNAPSHOT_FORMAT) {
    bad(`unsupported format (found ${JSON.stringify(env.aliranSnapshot)}, this build reads ${SNAPSHOT_FORMAT})`)
  }
  if (!SERVICES.includes(env.service)) bad(`unknown service "${env.service}"`)
  if (env.kind !== KIND_CONFIG && env.kind !== KIND_TEMPLATE) bad(`unknown kind "${env.kind}"`)
  if (!env.sections || typeof env.sections !== 'object' || Array.isArray(env.sections)) bad('no sections')
  if (expect.service && env.service !== expect.service) {
    throw new SnapshotError('mismatch', `this is a ${env.service} artifact — it cannot be applied to the ${expect.service}. Each service's config is its own; there is no cross-service import.`)
  }
  if (expect.kind && env.kind !== expect.kind) {
    throw new SnapshotError('mismatch', `this is a ${env.kind} artifact, and a ${expect.kind} was expected`)
  }
  return env
}

// Does this artifact claim to be secret-free, and is that claim structurally consistent?
// Used by the download route: it refuses anything that is not a clean template, so a bug
// that mislabels a snapshot cannot turn into a browser download of the signing material.
export function isDownloadable (env) {
  return env && env.kind === KIND_TEMPLATE && env.contains === CONTAINS_NONE
}

// ---------------------------------------------------------------- secret scanning
//
// The test-facing half of the feature. Give it the literal secret values that were seeded
// and it reports every place they survive, with a path — a failing assertion that says
// WHERE beats one that only says "a secret leaked". Substring matching, not equality: a
// secret embedded in a URL or concatenated into a label still counts as a leak.
export function findSecrets (value, needles) {
  const hits = []
  const list = (Array.isArray(needles) ? needles : [needles])
    .map((n) => (n && n.value !== undefined ? n : { value: n, label: String(n).slice(0, 8) + '…' }))
    .filter((n) => typeof n.value === 'string' && n.value.length >= 6) // shorter than this is noise

  const seen = new Set()
  const walk = (node, trail) => {
    if (node == null) return
    if (typeof node === 'string') {
      for (const n of list) if (node.includes(n.value)) hits.push({ path: trail || '(root)', label: n.label })
      return
    }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    for (const [k, v] of Object.entries(node)) {
      for (const n of list) if (k.includes(n.value)) hits.push({ path: (trail ? trail + '.' : '') + k, label: n.label, inKey: true })
      walk(v, (trail ? trail + '.' : '') + k)
    }
  }
  walk(value, '')
  return hits
}

// ---------------------------------------------------------------- on-disk store
//
// Snapshots live in DATA_DIR/config-snapshots/, at 0600 in a 0700 directory, because they
// hold secrets. That location is a deliberate trade, and the UI says so: a snapshot in the
// volume survives an OPERATOR MISTAKE (a deleted channel, a botched lineup) but NOT the
// loss of the volume itself. Volume loss is what the disaster-recovery archive is for, and
// that one has to live off the box.
//
// Naming is `<service>-config-<YYYYMMDD-HHMMSS>.json`, deliberately NOT the DR archive's
// `<service>-<date>-<time>.tar.gz`. The two must never be mistaken for each other — one is
// a JSON config blob, the other is a whole volume — and restore.sh matches archive names
// by prefix, so a lookalike name is an actual hazard rather than a cosmetic one.

const SNAP_RE = /^([a-z]+)-config-(\d{8}-\d{6})(?:-(\d+))?\.json$/

export function snapshotStamp (d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// `keep` caps the directory. Snapshots are cheap (a lineup of ~84 channels is tens of KB)
// but they are taken automatically before bulk operations, so an uncapped directory would
// grow without anybody deciding to let it.
export function makeSnapshotStore (dir, { service, keep = 20 } = {}) {
  if (!SERVICES.includes(service)) bad(`unknown service "${service}"`)

  const idPath = (id) => {
    // Names come off disk or out of a URL; both are untrusted. Matching the exact pattern
    // is also the traversal guard — no separators can survive it.
    if (!SNAP_RE.test(String(id))) throw new SnapshotError('not-found', `no such snapshot: ${id}`)
    return path.join(dir, id)
  }

  const readOne = (id) => {
    let raw
    try { raw = fs.readFileSync(idPath(id), 'utf8') } catch { throw new SnapshotError('not-found', `no such snapshot: ${id}`) }
    return parseEnvelope(raw, { service })
  }

  return {
    dir,

    // Newest first. A snapshot whose file is corrupt is REPORTED, not skipped — silently
    // hiding it would let an operator believe they have a rollback point they do not have.
    list () {
      let names = []
      try { names = fs.readdirSync(dir) } catch { return [] }
      const out = []
      for (const name of names) {
        const m = SNAP_RE.exec(name)
        if (!m || m[1] !== service) continue
        // The collision counter is part of the ORDER, not just the name: an auto-snapshot
        // and the manual one right after it share a second, and sorting on the timestamp
        // alone would leave "newest" arbitrary between them — which then decides which one
        // prune() throws away.
        const entry = { id: name, stamp: m[2], seq: m[3] ? Number(m[3]) : 1 }
        try {
          const st = fs.statSync(path.join(dir, name))
          entry.bytes = st.size
          const env = parseEnvelope(fs.readFileSync(path.join(dir, name), 'utf8'), { service })
          entry.createdAt = env.createdAt
          entry.note = env.note || ''
          entry.kind = env.kind
          entry.meta = env.meta || {}
          entry.sections = Object.keys(env.sections)
        } catch (err) {
          entry.unreadable = err.message
        }
        out.push(entry)
      }
      return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : b.seq - a.seq))
    },

    read: readOne,

    write (envelope, { note = '' } = {}) {
      if (envelope.kind !== KIND_CONFIG) bad('only a config snapshot is stored on the box; a template is a download')
      // Created here as well as by writeJsonAtomic below, because the readdirSync that
      // picks the sequence number runs first and would throw on a missing directory.
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const base = snapshotStamp()
      // Two snapshots inside one second (an auto-snapshot immediately followed by a manual
      // one) must not overwrite each other, AND the second one must sort as the newer.
      //
      // So the counter is one past the HIGHEST that second has used — not the first free
      // slot. Those differ once prune() has deleted something: a freed name would be reused
      // by a later write and, carrying the lower counter, would read as the OLDEST snapshot
      // of that second and be pruned immediately. That cost the newest snapshot.
      let maxSeq = 0
      for (const name of fs.readdirSync(dir)) {
        const m = SNAP_RE.exec(name)
        if (m && m[1] === service && m[2] === base) maxSeq = Math.max(maxSeq, m[3] ? Number(m[3]) : 1)
      }
      const id = maxSeq === 0 ? `${service}-config-${base}.json` : `${service}-config-${base}-${maxSeq + 1}.json`
      const env = note ? { ...envelope, note: String(note).slice(0, 500) } : envelope
      const file = writeJsonAtomic(path.join(dir, id), env, { mode: 0o600, dirMode: 0o700 })
      // Measure BEFORE pruning. prune() can legitimately delete this very file when `keep`
      // is small and several snapshots share a second, and statting a pruned file throws.
      const bytes = fs.statSync(file).size
      const pruned = this.prune()
      return { id, bytes, pruned, kept: !pruned.includes(id) }
    },

    remove (id) {
      const p = idPath(id)
      if (!fs.existsSync(p)) throw new SnapshotError('not-found', `no such snapshot: ${id}`)
      fs.unlinkSync(p)
      return { id, removed: true }
    },

    // Drop the oldest beyond `keep`. Unreadable files count toward the cap and are pruned
    // like any other — a corrupt snapshot is not a rollback point worth protecting.
    prune () {
      const all = this.list()
      const dead = all.slice(keep)
      for (const e of dead) { try { fs.unlinkSync(path.join(dir, e.id)) } catch {} }
      return dead.map((e) => e.id)
    }
  }
}
