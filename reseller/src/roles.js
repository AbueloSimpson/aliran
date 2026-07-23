// The reseller hierarchy's single source of truth: role → capability map plus the
// parent-chain scope helpers. Every route gate goes through here — no role-string
// checks anywhere else (the scattered-strings trap the FireShare panel fell into).
//
// Roles (top to bottom): admin → co-admin → super → reseller.
//   - admin: the seeded ROOT record (root:true, exactly one, undeletable). Mints
//     credits; the only principal that can create/delete co-admins.
//   - co-admin: a FULL admin clone (incl. minting) — exists so the owner can hand
//     out a second all-powers login with its own audit trail. The one carve-out:
//     co-admins cannot manage other co-admins or the root (root-only).
//   - super: a super-reseller. Creates resellers under itself, funds them from its
//     OWN balance, manages only its own subtree.
//   - reseller: activates/manages viewer accounts under its own prefix, spending
//     its own balance.

import { ControlError } from './errors.js'

export const ROLES = ['admin', 'co-admin', 'super', 'reseller']

// Capability → roles that hold it. Capabilities marked rootOnly additionally
// require the actor record's root flag (the seeded admin).
export const CAPS = {
  'principal:create:co-admin': { roles: ['admin'], rootOnly: true },
  'principal:create:super': { roles: ['admin', 'co-admin'] },
  'principal:create:reseller': { roles: ['admin', 'co-admin', 'super'] },
  'principal:manage': { roles: ['admin', 'co-admin', 'super'] }, // scope via canManage
  'principal:limits': { roles: ['admin', 'co-admin', 'super'] },
  'credits:mint': { roles: ['admin', 'co-admin'] },
  'credits:adjust': { roles: ['admin', 'co-admin'] },
  'credits:transfer': { roles: ['admin', 'co-admin', 'super'] },
  'credits:reclaim': { roles: ['admin', 'co-admin', 'super'] },
  'accounts:manage': { roles: ['admin', 'co-admin', 'super', 'reseller'] }, // scope via accountScope
  'trials:create': { roles: ['admin', 'co-admin', 'super', 'reseller'] },
  'ledger:view-all': { roles: ['admin', 'co-admin'] },
  'panel:status': { roles: ['admin', 'co-admin'] },
  'ops:reconcile': { roles: ['admin', 'co-admin'] },
  'ops:sweep': { roles: ['admin', 'co-admin'] }
}

export function can (record, cap) {
  const def = CAPS[cap]
  if (!def) return false
  if (!def.roles.includes(record.role)) return false
  if (def.rootOnly && !record.root) return false
  return true
}

export function requireCap (record, cap) {
  if (!can(record, cap)) throw new ControlError('forbidden', `role "${record.role}" may not ${cap.replace(/:/g, ' ')}`)
}

const isAdminTier = (r) => r === 'admin' || r === 'co-admin'

// True when `name` is `ancestorName` itself or one of its descendants (walking
// parent pointers up from `name`). The visited set guards against a corrupted
// store introducing a parent cycle — better a false negative than a spin.
export function inSubtree (principals, ancestorName, name) {
  const visited = new Set()
  let cur = name
  while (cur != null && !visited.has(cur)) {
    if (cur === ancestorName) return true
    visited.add(cur)
    cur = principals[cur] ? principals[cur].parent : null
  }
  return false
}

// May `actor` manage (status/password/limits/delete) `target`? The root record is
// managed by nobody (its password only by itself, via /api/me). Co-admins are
// root-only territory. Admin tiers reach everything else; supers only their own
// subtree (not themselves — self-service is /api/me).
export function canManage (principals, actor, targetName) {
  const target = principals[targetName]
  if (!target) return false
  if (target.root) return false
  if (target.role === 'co-admin') return !!actor.root
  if (isAdminTier(actor.role)) return true
  if (actor.role === 'super') return targetName !== actor.name && inSubtree(principals, actor.name, targetName)
  return false
}

export function requireManage (principals, actor, targetName) {
  if (!canManage(principals, actor, targetName)) {
    // Distinguish "no such principal" (404) from a scope denial (403).
    if (!principals[targetName]) throw new ControlError('not-found', `no such principal: ${targetName}`)
    throw new ControlError('forbidden', `"${actor.name}" may not manage "${targetName}"`)
  }
}

// The set of principals whose viewer accounts `record` may see/operate on:
// '*' for the admin tiers, else self + every descendant.
export function accountScope (principals, record) {
  if (isAdminTier(record.role)) return '*'
  const scope = new Set([record.name])
  let grew = true
  while (grew) {
    grew = false
    for (const [name, p] of Object.entries(principals)) {
      if (!scope.has(name) && p.parent && scope.has(p.parent)) { scope.add(name); grew = true }
    }
  }
  return scope
}

export function inAccountScope (scope, ownerName) {
  return scope === '*' || scope.has(ownerName)
}
