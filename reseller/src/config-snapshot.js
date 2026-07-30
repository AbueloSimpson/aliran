// Reseller config snapshots and templates — see @aliran/core/config-snapshot.js for the
// envelope and why there are three artifacts.
//
// THIS SERVICE IS EXPORT-ONLY, AND THAT IS A DESIGN DECISION, NOT A GAP
//
// The other three services can put a config artifact back. A reseller cannot, because both
// of the things it would restore are unsafe to restore:
//
//   principals (secrets/principals.json)
//     The role hierarchy and its Argon2id verifiers. A principal record carries
//     `tokenVersion`, which is bumped to kill every session issued under a leaked password.
//     Writing an older copy back rewinds that counter and hands those sessions their access
//     again — a silent security regression caused by an operator fixing something else.
//     Same rule as the panel's admins and publishers.
//
//   accounts (accounts.json)
//     The managed-account map. Two independent problems. First, balances are derived from
//     the credit LEDGER, which this artifact deliberately does not carry (see below), so a
//     rewound account map disagrees with the ledger that funds it — wrong in a way nobody
//     notices until an audit. Second, the running service holds this registry in memory and
//     only writes it on its own operations, so a file written underneath it is discarded at
//     the next account change.
//
// The ledger itself (ledger/ledger.jsonl) is not captured at all. It is an append-only
// business RECORD, not configuration: rolling it back erases mints and transfers that
// really happened. It belongs in the disaster-recovery archive of the whole DATA_DIR.
//
// So: putting a reseller back is a DATA-VOLUME restore (deploy/restore.sh), not a config
// restore. The dashboard says exactly that rather than offering a button that would produce
// a plausible-looking, wrong deployment. What this module does provide is real and useful:
//
//   - a config SNAPSHOT, so the hierarchy and the account map are captured on the box and
//     can be read by hand during a recovery,
//   - a config TEMPLATE, so an operator can see the hierarchy shape, diff what changed over
//     time, and rebuild the same structure on a second site.

import {
  KIND_CONFIG, KIND_TEMPLATE, makeEnvelope, applyTemplateSpec, SnapshotError
} from '@aliran/core/config-snapshot.js'
import { readJsonFile } from './store.js'
import { loadPrincipals } from './control-auth.js'
import path from 'path'

export const SERVICE = 'reseller'

// No section here is restorable. The reasons are per-section because they are different
// reasons, and an operator deserves the specific one.
export const SECTIONS = {
  principals: {
    restorable: false,
    label: 'Principals',
    reason: 'Captured so the snapshot is complete. It is never written back: rewinding tokenVersion would give revoked sessions their access again. Re-create a principal with reseller-cli.'
  },
  accounts: {
    restorable: false,
    label: 'Managed accounts',
    reason: 'Captured for reference. It is never written back: account balances come from the credit ledger, which is not in this artifact, so a rewound map would disagree with the ledger that funds it.'
  }
}

export const RESTORE_SUPPORTED = false

export const RESTORE_NOTE = 'A reseller is put back with a data-volume restore (deploy/restore.sh), not a config restore. The credit ledger is the record of record, and no config artifact carries it.'

export const TEMPLATE_SPEC = {
  drop: [
    { section: 'accounts', reason: 'Customer records, not structure — a second site starts with none.' }
  ],
  redact: [
    { path: 'principals.*.salt', reason: 'Password salt.' },
    { path: 'principals.*.verifier', reason: 'Argon2id password verifier.' },
    { path: 'principals.*.argon', reason: 'Password hashing parameters.' },
    { path: 'principals.*.tokenVersion', reason: 'Session revocation counter — site state.' },
    { path: 'principals.*.createdAt', reason: 'Site history.' },
    { path: 'principals.*.createdBy', reason: 'Site history.' }
  ]
}

const accountsPath = (dataDir) => path.join(dataDir, 'accounts.json')

function collect (ctx) {
  return {
    principals: loadPrincipals(ctx.dataDir),
    accounts: readJsonFile(accountsPath(ctx.dataDir), {})
  }
}

function summarize (sections) {
  const principals = Object.values(sections.principals || {})
  const accounts = Object.values(sections.accounts || {})
  return {
    principals: principals.length,
    byRole: principals.reduce((acc, p) => { if (p && p.role) acc[p.role] = (acc[p.role] || 0) + 1; return acc }, {}),
    accounts: accounts.length,
    activeAccounts: accounts.filter((a) => a && a.status !== 'deleted').length
  }
}

export function buildSnapshot (ctx, { note = '' } = {}) {
  const sections = collect(ctx)
  return makeEnvelope({ service: SERVICE, kind: KIND_CONFIG, sections, meta: summarize(sections), note })
}

export function buildTemplate (ctx, { note = '' } = {}) {
  const { sections, omitted } = applyTemplateSpec(collect(ctx), TEMPLATE_SPEC)
  const env = makeEnvelope({ service: SERVICE, kind: KIND_TEMPLATE, sections, omitted, meta: summarize(sections), note })
  env.meta.importable = false
  env.meta.importNote = 'A reference export. A principal is a login, and a template holds no credentials, so importing one could only make accounts nobody can sign in as. Rebuild the hierarchy with reseller-cli.'
  return env
}

// Present so the four services share one route shape. It always refuses, with the reason.
export function plan (ctx, env) {
  return {
    service: SERVICE,
    kind: env.kind,
    supported: false,
    warnings: [RESTORE_NOTE, SECTIONS.principals.reason, SECTIONS.accounts.reason]
  }
}

export function apply () {
  throw new SnapshotError('bad-request', RESTORE_NOTE)
}

export { SnapshotError }
