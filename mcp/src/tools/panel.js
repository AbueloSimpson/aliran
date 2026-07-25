// panel_* tools — thin wrappers over the panel admin API (panel/src/admin-server.js).
// Registered only when the config has a `panel` block. GETs carry readOnlyHint;
// purges/deletes/revokes carry destructiveHint so the client confirms first.
//
// Passwords: create_user / set_user_password accept an optional `password`. When
// omitted a strong one is generated and RETURNED in the result — the operator can
// hand it to the viewer. (A viewer account password is operational data the operator
// is directing, not a system secret; the panel/broadcaster admin passwords and the
// SSH key stay in the local config and never appear in a tool result.)

import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import { z } from 'zod'

export function genPassword () {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const b = randomBytes(20)
  let s = ''
  for (let i = 0; i < b.length; i++) s += A[b[i] % A.length]
  return s
}

const q = (v) => encodeURIComponent(String(v))

// G11: a user summary's grants/manualGrants can be hundreds of ids (bouquet
// deployments run 350+ channels), which floods an AI client's context on every
// user mutation. ONE mechanism everywhere a user summary is returned: id arrays
// longer than GRANTS_INLINE_MAX collapse to { count, sample } and the result says
// so; pass full:true for the complete lists. Short arrays pass through untouched,
// so small deployments never see the summary shape. (Shared with the reseller
// account view — reseller.js imports this.)
const GRANTS_INLINE_MAX = 12
const GRANTS_SAMPLE = 8
export function compactUser (u, full) {
  if (full || !u || typeof u !== 'object' || Array.isArray(u)) return u
  const out = { ...u }
  let touched = false
  for (const k of ['grants', 'manualGrants']) {
    if (Array.isArray(out[k]) && out[k].length > GRANTS_INLINE_MAX) {
      out[k] = { count: out[k].length, sample: out[k].slice(0, GRANTS_SAMPLE) }
      touched = true
    }
  }
  if (touched) out.note = 'grants/manualGrants summarized to {count, sample} — pass full:true for the complete id lists'
  return out
}
const FULL_ARG = { full: z.boolean().optional().describe(`return the complete grants/manualGrants id lists (default: lists longer than ${GRANTS_INLINE_MAX} ids are summarized to {count, sample})`) }

// G12: 64 hex chars = 32 bytes — the shape of both a hypercore feed public key
// (feedKey) and a stream encryption secret (key). The panel stores feedKey
// unvalidated, but a typo'd hex string would strand every client silently, so the
// tool checks the shape loudly before it ships.
const HEX64 = /^[0-9a-f]{64}$/i

// Stream art (G7): the image is read from the OPERATOR's machine (this process's
// disk) and POSTed as raw bytes — image data never transits the model as base64.
// The extension whitelist doubles as the content-type map (the panel derives the
// stored extension from the content-type), and the 10 MiB cap mirrors the panel's
// own body limit so an oversize file fails fast client-side.
const ART_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
const ART_MAX_BYTES = 10 * 1024 * 1024

function expandHome (p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function registerPanelTools (ctx, h) {
  const { def, ok } = h
  const p = ctx.panel

  // ---- read (readOnlyHint) ----
  def('panel_status', { title: 'Panel status', description: 'Panel summary: user/stream/admin counts and identity.', annotations: { readOnlyHint: true } },
    async () => ok(await p.get('/api/status')))

  def('panel_observability', { title: 'Panel observability', description: 'Panel uptime, memory, swarm connections, data-dir size, and the recent admin/session/register activity ring.', annotations: { readOnlyHint: true } },
    async () => ok(await p.get('/api/observability')))

  def('panel_list_users', {
    title: 'List users',
    description: 'List viewer accounts (prefix search + cursor paging). Returns {users,next}. Each user\'s long grant lists come back as {count, sample} — full:true for every id.',
    inputSchema: { prefix: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), ...FULL_ARG },
    annotations: { readOnlyHint: true }
  }, async ({ prefix, after, limit, full }) => {
    const qs = []
    if (prefix) qs.push('prefix=' + q(prefix))
    if (after) qs.push('after=' + q(after))
    if (limit) qs.push('limit=' + q(limit))
    const out = await p.get('/api/users' + (qs.length ? '?' + qs.join('&') : ''))
    return ok(out && Array.isArray(out.users) ? { ...out, users: out.users.map((u) => compactUser(u, full)) } : out)
  })

  def('panel_get_user', {
    title: 'Get user',
    description: 'One viewer account: grants, packages, manualGrants, devices, status. Long grant lists come back as {count, sample} — full:true for every id.',
    inputSchema: { username: z.string(), ...FULL_ARG },
    annotations: { readOnlyHint: true }
  }, async ({ username, full }) => ok(compactUser(await p.get('/api/users/' + q(username)), full)))

  def('panel_list_devices', { title: 'List a user\'s devices', description: 'Enrolled devices for a viewer account.', inputSchema: { username: z.string() }, annotations: { readOnlyHint: true } },
    async ({ username }) => ok(await p.get('/api/users/' + q(username) + '/devices')))

  def('panel_list_streams', {
    title: 'List streams',
    description: 'The channel catalog (P2P + redirect channels). With no arguments the raw full catalog comes back, exactly as before. Client-side filters for large catalogs (the panel returns everything; nothing new hits the API): category (an exact tag, or a parent matching its \'Parent/Child\' children), prefix (stream-id prefix), idsOnly (ids instead of full records), limit. With any filter set, the result is {total, matched, returned, streams|ids} so nothing is dropped silently.',
    inputSchema: {
      category: z.string().optional(),
      prefix: z.string().optional(),
      idsOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ category, prefix, idsOnly, limit }) => {
    const all = await p.get('/api/streams')
    if (category === undefined && prefix === undefined && !idsOnly && limit === undefined) return ok(all)
    let rows = Array.isArray(all) ? all : []
    if (category !== undefined) rows = rows.filter((s) => (Array.isArray(s.category) ? s.category : []).some((c) => c === category || String(c).startsWith(category + '/')))
    if (prefix !== undefined) rows = rows.filter((s) => String(s.id).startsWith(prefix))
    const matched = rows.length
    if (limit !== undefined) rows = rows.slice(0, limit)
    return ok({ total: Array.isArray(all) ? all.length : 0, matched, returned: rows.length, ...(idsOnly ? { ids: rows.map((s) => s.id) } : { streams: rows }) })
  })

  def('panel_list_packages', { title: 'List channel packages', description: 'Channel packages (bouquets) with resolved-channel and holder counts.', annotations: { readOnlyHint: true } },
    async () => ok(await p.get('/api/packages')))

  def('panel_get_package', { title: 'Get a package', description: 'One package plus the exact stream ids it resolves to right now.', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
    async ({ name }) => ok(await p.get('/api/packages/' + q(name))))

  def('panel_list_sources', { title: 'List remote sources', description: 'Remote channel sources (S27) and their owned-channel counts.', annotations: { readOnlyHint: true } },
    async () => ok(await p.get('/api/sources')))

  def('panel_source_channels', {
    title: 'List a source\'s channels',
    description: 'Every channel a remote source knows about: imported entries (feedId, catalog id, title, order) followed by the operator-excluded ones (excluded:true). This is the curation view — pair it with the `exclude` field of panel_set_source to deselect provider channels.',
    inputSchema: { name: z.string() },
    annotations: { readOnlyHint: true }
  }, async ({ name }) => ok(await p.get('/api/sources/' + q(name) + '/channels')))

  def('panel_list_categories', { title: 'List categories', description: 'Category vocabulary + per-category channel counts.', annotations: { readOnlyHint: true } },
    async () => ok(await p.get('/api/categories')))

  def('panel_list_publishers', { title: 'List publishers', description: 'Enrolled broadcaster identities (S26) with scopes + status (never secrets).', annotations: { readOnlyHint: true } },
    async () => ok(await p.get('/api/publishers')))

  def('panel_analytics', {
    title: 'Panel analytics',
    description: 'Aggregate-only analytics rollups (S48): logins ok/failed, sessions issued, unique viewers/day, apps-online gauge and catalog composition, per hour/UTC day. days = how many days back (default 7). Counts only — no usernames/keys/IPs exist in this surface, and connection-derived figures are lower bounds ("≥ N").',
    inputSchema: { days: z.number().int().min(1).max(3650).optional() },
    annotations: { readOnlyHint: true }
  }, async ({ days }) => ok(await p.get('/api/analytics' + (days ? '?days=' + q(days) : ''))))

  def('panel_list_admins', {
    title: 'List dashboard admins',
    description: 'Panel dashboard admin accounts (name/status/createdAt — never password material). These are the operator logins for the admin API + dashboard, not viewer accounts.',
    annotations: { readOnlyHint: true }
  }, async () => ok(await p.get('/api/admins')))

  // ---- users: create / mutate ----
  def('panel_create_user', {
    title: 'Create a viewer account',
    description: 'Create a viewer account. If password is omitted a strong one is generated and returned so you can hand it to the viewer. Default packages + source auto-grants are applied automatically; long grant lists come back as {count, sample} — full:true for every id.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional(), ...FULL_ARG }
  }, async ({ username, password, full }) => {
    const pw = password || genPassword()
    const out = await p.post('/api/users', { username, password: pw })
    return ok({ ...compactUser(out, full), generatedPassword: password ? undefined : pw })
  })

  def('panel_set_user_password', {
    title: 'Set a user password',
    description: 'Reset a viewer account password (re-seals grants). Omit password to generate + return a strong one.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional(), ...FULL_ARG }
  }, async ({ username, password, full }) => {
    const pw = password || genPassword()
    const out = await p.post('/api/users/' + q(username) + '/password', { password: pw })
    return ok({ ...compactUser(out, full), generatedPassword: password ? undefined : pw })
  })

  def('panel_set_user_status', { title: 'Enable/disable a user', description: 'Set a viewer account active or disabled (disable revokes live sessions).', inputSchema: { username: z.string(), status: z.enum(['active', 'disabled']), ...FULL_ARG } },
    async ({ username, status, full }) => ok(compactUser(await p.post('/api/users/' + q(username) + '/status', { status }), full)))

  def('panel_set_max_devices', { title: 'Set max devices', description: 'Set the concurrent-device limit for a viewer account. Long grant lists come back as {count, sample} — full:true for every id.', inputSchema: { username: z.string(), maxDevices: z.number().int().min(1), ...FULL_ARG } },
    async ({ username, maxDevices, full }) => ok(compactUser(await p.post('/api/users/' + q(username) + '/max-devices', { maxDevices }), full)))

  def('panel_logout_all', { title: 'Log out all devices', description: 'Revoke every session for a viewer account (tokenVersion bump).', inputSchema: { username: z.string(), ...FULL_ARG } },
    async ({ username, full }) => ok(compactUser(await p.post('/api/users/' + q(username) + '/logout-all', {}), full)))

  def('panel_grant', { title: 'Grant a stream', description: 'Grant a viewer account a single stream (adds a manual entitlement, sealed to the user key). Long grant lists come back as {count, sample} — full:true for every id.', inputSchema: { username: z.string(), streamId: z.string(), ...FULL_ARG } },
    async ({ username, streamId, full }) => ok(compactUser(await p.post('/api/users/' + q(username) + '/grants', { streamId }), full)))

  def('panel_set_user_packages', { title: 'Set a user\'s packages', description: 'Replace the viewer\'s package list (bouquets); grants materialize immediately. Long grant lists come back as {count, sample} — full:true for every id.', inputSchema: { username: z.string(), packages: z.array(z.string()), ...FULL_ARG } },
    async ({ username, packages, full }) => ok(compactUser(await p.post('/api/users/' + q(username) + '/packages', { packages }), full)))

  // ---- streams / packages / sources: create / mutate ----
  def('panel_add_stream', {
    title: 'Add a stream',
    description: 'Add a channel. Provide `url` (https) for a REDIRECT channel (viewers play the url, no P2P feed); otherwise a P2P channel a broadcaster will register a feed for. Pre-seeded feed flows (operator KB): `feedKey` (64 hex) pre-binds an existing broadcaster feed, and `key` (64 hex) supplies that feed\'s encryption secret so grants seal the RIGHT key. `key` is a SECRET input — a supplied key is stored panel-side and NEVER echoed back in the result. Omit `key` and the panel mints one, returned ONCE here (`encryptionKey`) for the broadcaster\'s data/feed.key — there is no read-back API later.',
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      category: z.union([z.string(), z.array(z.string())]).optional(),
      url: z.string().optional(),
      order: z.number().int().optional(),
      featured: z.boolean().optional(),
      feedKey: z.string().regex(HEX64, 'feedKey must be 64 hex chars (the hypercore feed public key)').optional(),
      key: z.string().regex(HEX64, 'key must be 64 hex chars (a 32-byte stream encryption secret)').optional()
    }
  }, async (a) => {
    const out = await p.post('/api/streams', a)
    // A SUPPLIED key is a secret the operator already holds — echoing it back
    // would copy it into the model context for nothing. A panel-GENERATED key
    // keeps the generated-password pattern: returned once, or it is nowhere.
    if (a.key && out && typeof out === 'object') {
      return ok({ ...out, encryptionKey: undefined, encryptionKeyNote: 'redacted — you supplied `key`, so you already hold the secret; it was stored panel-side (secrets/streams.json)' })
    }
    return ok(out)
  })

  def('panel_set_stream_meta', {
    title: 'Edit a stream',
    description: 'Patch channel metadata (title/description/category/order/featured/isLive/status/url). `feedKey` (64 hex) re-points the P2P feed — the paired blobsKey resets and is re-filled from the next real registration. The encryption `key` is fixed at creation (add-only): re-keying a stream is delete + re-add, which mints a fresh key and invalidates old grants.',
    inputSchema: { id: z.string(), title: z.string().optional(), description: z.string().optional(), category: z.union([z.string(), z.array(z.string())]).optional(), url: z.string().optional(), isLive: z.boolean().optional(), status: z.string().optional(), order: z.number().int().nullable().optional(), featured: z.boolean().optional(), feedKey: z.string().regex(HEX64, 'feedKey must be 64 hex chars (the hypercore feed public key)').optional() }
  }, async ({ id, ...body }) => ok(await p.patch('/api/streams/' + q(id), body)))

  def('panel_add_package', {
    title: 'Create a package',
    description: 'Create a channel package (bouquet). members: stream ids, id globs, or selectors category:<slug> / source:<name>. default:true auto-assigns it to new accounts.',
    inputSchema: { name: z.string(), label: z.string().optional(), members: z.union([z.string(), z.array(z.string())]).optional(), default: z.boolean().optional() }
  }, async (a) => ok(await p.post('/api/packages', a)))

  def('panel_set_package', {
    title: 'Edit a package',
    description: 'Edit a package label/members/default. Member edits materialize sealed grants for every holder.',
    inputSchema: { name: z.string(), label: z.string().optional(), members: z.union([z.string(), z.array(z.string())]).optional(), default: z.boolean().optional() }
  }, async ({ name, ...body }) => ok(await p.patch('/api/packages/' + q(name), body)))

  def('panel_add_source', {
    title: 'Add a remote source',
    description: 'Add a remote channel-list source (provider JSON) materialized as a category of redirect channels.',
    inputSchema: { name: z.string(), url: z.string(), category: z.string(), prefix: z.string().optional(), autoGrant: z.boolean().optional(), enabled: z.boolean().optional(), intervalMs: z.number().int().optional() }
  }, async (a) => ok(await p.post('/api/sources', a)))

  def('panel_set_source', {
    title: 'Edit a remote source',
    description: 'Edit any field of a remote source. `exclude` REPLACES the deselect list: feed ids (unprefixed, as panel_source_channels reports them) the sync must skip — pass [{id,title}] objects or bare id strings. Changing the exclusion set resets the source\'s ETag, so the next sync re-pulls the full feed body and re-diffs (excluded channels already imported are removed then).',
    inputSchema: { name: z.string(), url: z.string().optional(), category: z.string().optional(), prefix: z.string().optional(), autoGrant: z.boolean().optional(), enabled: z.boolean().optional(), intervalMs: z.number().int().optional(), exclude: z.array(z.union([z.string(), z.object({ id: z.string(), title: z.string().optional() })])).optional() }
  }, async ({ name, ...body }) => ok(await p.patch('/api/sources/' + q(name), body)))

  def('panel_sync_source', { title: 'Sync a remote source now', description: 'Pull + diff + grant a source immediately; returns the sync report.', inputSchema: { name: z.string() } },
    async ({ name }) => ok(await p.post('/api/sources/' + q(name) + '/sync', {})))

  // ---- categories (S49b): presentation registry + catalog-wide moves ----
  // Slugs travel in the request BODY on every category route (two-level rails are
  // 'Parent/Child' — a slash in a path segment would split it).
  def('panel_set_category', {
    title: 'Set category presentation',
    description: 'Upsert a category\'s PRESENTATION: label, rail order (0-9999, null clears), hidden. Touches only the registry entry — which channels carry the category (membership) is untouched. Slugs are one- or two-level (\'Deportes\' or \'Deportes/Futbol\').',
    inputSchema: { slug: z.string(), label: z.string().optional(), order: z.number().int().min(0).max(9999).nullable().optional(), hidden: z.boolean().optional() }
  }, async (a) => ok(await p.post('/api/categories', a)))

  def('panel_rename_category', {
    title: 'Rename a category',
    description: 'Rename a category EVERYWHERE: rewrites the category tag on every channel record in the catalog (renaming a parent carries its \'Parent/Child\' children along) and moves the registry entries. Package category:<slug> selectors are strings re-resolved after the move — one naming the OLD slug now matches nothing and its covered grants are removed; update that package\'s members to the new slug (panel_set_package) to keep its holders entitled. Returns how many channel records and registry entries moved.',
    inputSchema: { from: z.string(), to: z.string() }
  }, async ({ from, to }) => ok(await p.patch('/api/categories', { from, to })))

  def('panel_merge_categories', {
    title: 'Merge categories',
    description: 'Merge one or more categories INTO another: every channel tagged with a `from` category is retagged with `to` across the whole catalog, and the `from` registry entries are deleted. Reversing requires knowing the old membership — treat as a bulk rewrite. Package category:<slug> selectors re-resolve after the move (a selector on a `from` slug loses its channels; one on `to` gains them).',
    inputSchema: { from: z.array(z.string()).min(1), to: z.string() },
    annotations: { destructiveHint: true }
  }, async ({ from, to }) => ok(await p.patch('/api/categories', { op: 'merge', from, to })))

  // Publishers: enrollment mints a SECRET. It never comes back to you — with SSH
  // configured it is written into the box's broadcaster/.env; otherwise it is
  // withheld and you're told to place PUBLISHER_KEY in the broadcaster .env by hand.
  def('panel_add_publisher', {
    title: 'Enroll a publisher',
    description: 'Enroll a broadcaster identity (per-site key + channel scopes). The secret key is NEVER returned to you: it is written into the target box\'s broadcaster/.env when SSH is configured, otherwise withheld. Multi-box sites: `host` names an entry in ssh.hosts so the key lands on the RIGHT box\'s broadcaster (omit = the default box). Note the env change applies on that broadcaster\'s next recreate (docker compose up -d broadcaster) — a plain restart does not re-read env files.',
    inputSchema: { name: z.string(), scopes: z.array(z.string()).optional(), host: z.string().optional().describe('named box from ssh.hosts whose broadcaster/.env receives the key (omit = the default box)') }
  }, async ({ name, scopes, host }) => {
    // Resolve the target box BEFORE enrolling: an unknown host name must fail the
    // whole call, not strand a freshly-minted secret with nowhere to write it.
    let targetSsh = null
    if (ctx.ssh && ctx.ssh.configured) targetSsh = ctx.sshFor(host)
    else if (host) throw new Error(`host "${host}" given but there is no "ssh" block in the config`)
    const out = await p.post('/api/publishers', { name, scopes })
    const { secretKey, ...safe } = out
    let secretDisposition
    if (targetSsh && secretKey) {
      try {
        const envPath = `${ctx.repoDirFor(host)}/broadcaster/.env`
        await ctx.upsertEnvOn(host, envPath, { PUBLISHER_NAME: name, PUBLISHER_KEY: secretKey })
        secretDisposition = `written to ${envPath} on ${targetSsh.host} (recreate that broadcaster to apply: docker compose up -d broadcaster)`
      } catch (err) {
        secretDisposition = `WITHHELD — could not write it to the box (${err.message}); enroll via the dashboard/CLI and place PUBLISHER_KEY in the broadcaster .env yourself`
      }
    } else {
      secretDisposition = 'WITHHELD — no SSH configured; the secret is shown once by the panel. Enroll via the dashboard/CLI and place PUBLISHER_NAME/PUBLISHER_KEY in that site\'s broadcaster .env'
    }
    return ok({ ...safe, secretKey: undefined, secretDisposition })
  })

  def('panel_set_publisher_scopes', { title: 'Set publisher scopes', description: 'Replace a publisher\'s streamId scope globs (applies from its next registration).', inputSchema: { name: z.string(), scopes: z.array(z.string()) } },
    async ({ name, scopes }) => ok(await p.post('/api/publishers/' + q(name) + '/scopes', { scopes })))

  def('panel_set_publisher_status', { title: 'Activate/revoke a publisher', description: 'Set a publisher active or revoked.', inputSchema: { name: z.string(), status: z.enum(['active', 'revoked']) } },
    async ({ name, status }) => ok(await p.post('/api/publishers/' + q(name) + '/status', { status })))

  // ---- stream art (S49b): raw bytes from the OPERATOR's disk ----
  def('panel_set_stream_art', {
    title: 'Upload stream art',
    description: 'Upload channel art (logo / poster / backdrop) for a stream from an image file on the OPERATOR\'s machine — the machine running this MCP server, not the panel box. The bytes are POSTed raw to the panel (they never appear in a tool result); allowed: .png .jpg .jpeg .webp .gif, at most 10 MiB. The result echoes the stored asset ref.',
    inputSchema: { id: z.string(), kind: z.enum(['logo', 'poster', 'backdrop']), path: z.string().describe('image file path on the operator\'s machine') }
  }, async ({ id, kind, path: artPath }) => {
    const file = path.resolve(expandHome(artPath))
    const ext = path.extname(file).toLowerCase()
    const contentType = ART_CONTENT_TYPES[ext]
    if (!contentType) throw new Error(`unsupported art file extension "${ext || '(none)'}" — allowed: ${Object.keys(ART_CONTENT_TYPES).join(' ')}`)
    let st
    try { st = fs.statSync(file) } catch { throw new Error(`cannot read ${file} — the path must exist on the OPERATOR's machine (where this MCP server runs)`) }
    if (!st.isFile()) throw new Error(`${file} is not a file`)
    if (st.size === 0) throw new Error(`${file} is empty`)
    if (st.size > ART_MAX_BYTES) throw new Error(`${file} is ${(st.size / 1048576).toFixed(1)} MiB — the panel caps art at 10 MiB; shrink the image first`)
    const buf = fs.readFileSync(file)
    const out = await p.postRaw('/api/streams/' + q(id) + '/art/' + q(kind), buf, contentType)
    return ok({ ...out, uploadedFrom: file })
  })

  // ---- dashboard admins (S49a) ----
  def('panel_add_admin', {
    title: 'Add a dashboard admin',
    description: 'Create a panel dashboard admin account (full panel control — for co-operators, not viewers). If password is omitted a strong one is generated and returned so you can hand it over.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional() }
  }, async ({ username, password }) => {
    const pw = password || genPassword()
    const out = await p.post('/api/admins', { username, password: pw })
    return ok({ ...out, generatedPassword: password ? undefined : pw })
  })

  def('panel_set_admin_password', {
    title: 'Set a dashboard admin password',
    description: 'Rotate a panel dashboard admin password (bumps tokenVersion: every live session for that admin dies, dashboard logins included). Omit password to generate + return one. CAUTION: if this is the account this MCP itself logs in with (config "panel.user"/"pass"), update the operator\'s local mcp config (mcp/config.json) right afterwards — the panel_* tools re-login with the configured password and will fail auth until it matches.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional() }
  }, async ({ username, password }) => {
    const pw = password || genPassword()
    const out = await p.post('/api/admins/' + q(username) + '/password', { password: pw })
    return ok({ ...out, generatedPassword: password ? undefined : pw })
  })

  // ---- destructive (destructiveHint) ----
  def('panel_delete_user', { title: 'Delete a user', description: 'Delete a viewer account record.', inputSchema: { username: z.string() }, annotations: { destructiveHint: true } },
    async ({ username }) => ok(await p.del('/api/users/' + q(username))))

  def('panel_revoke_device', { title: 'Revoke a device', description: 'Drop one device enrollment from a viewer account.', inputSchema: { username: z.string(), deviceId: z.string() }, annotations: { destructiveHint: true } },
    async ({ username, deviceId }) => ok(await p.del('/api/users/' + q(username) + '/devices/' + q(deviceId))))

  def('panel_revoke_grant', {
    title: 'Revoke a grant',
    description: 'Remove a viewer\'s MANUAL entitlement for a stream. A package that still covers the stream re-seals it in the same request — the result\'s stillGranted field says so honestly (edit the covering package to truly revoke). Long grant lists come back as {count, sample} — full:true for every id.',
    inputSchema: { username: z.string(), streamId: z.string(), ...FULL_ARG },
    annotations: { destructiveHint: true }
  }, async ({ username, streamId, full }) => {
    const out = await p.del('/api/users/' + q(username) + '/grants/' + q(streamId))
    // Derived BEFORE compaction so the covered-revoke honesty survives the summary.
    const covered = out && Array.isArray(out.grants) && out.grants.includes(streamId)
    return ok({ ...compactUser(out, full), stillGranted: covered ? `yes — a package still covers ${streamId} (the panel re-sealed it in this request); remove it from the covering package or the package from the user to truly revoke` : false })
  })

  def('panel_delete_stream', { title: 'Purge a stream', description: 'FULL purge of a channel: catalog record, private key, grants and art. Irreversible.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => ok(await p.del('/api/streams/' + q(id))))

  def('panel_delete_package', { title: 'Delete a package', description: 'Remove a package and strip it from users (grants covered only by it are removed; manual grants survive).', inputSchema: { name: z.string() }, annotations: { destructiveHint: true } },
    async ({ name }) => ok(await p.del('/api/packages/' + q(name))))

  def('panel_delete_source', { title: 'Delete a remote source', description: 'Remove a source and purge its channels (keepChannels detaches them instead).', inputSchema: { name: z.string(), keepChannels: z.boolean().optional() }, annotations: { destructiveHint: true } },
    async ({ name, keepChannels }) => ok(await p.del('/api/sources/' + q(name) + (keepChannels ? '?keepChannels=1' : ''))))

  def('panel_delete_category', {
    title: 'Delete a category registry entry',
    description: 'Drop a category\'s PRESENTATION registry entry (label/order/hidden). Channels KEEP the tag — the category reappears in listings as unregistered while anything still carries it; use panel_rename_category / panel_merge_categories to move channels off a label.',
    inputSchema: { slug: z.string() },
    annotations: { destructiveHint: true }
  }, async ({ slug }) => ok(await p.del('/api/categories', { slug })))

  def('panel_remove_publisher', { title: 'Remove a publisher', description: 'Hard-delete a publisher enrollment (prefer set_publisher_status revoked to keep the audit trail).', inputSchema: { name: z.string() }, annotations: { destructiveHint: true } },
    async ({ name }) => ok(await p.del('/api/publishers/' + q(name))))

  def('panel_remove_admin', {
    title: 'Remove a dashboard admin',
    description: 'Delete a panel dashboard admin account. CAUTION: removing the account this MCP logs in with (config "panel.user") locks the panel_* tools out; removing the LAST admin locks the dashboard entirely — recover on the box with `docker compose run --rm panel node src/admin-cli.js add-admin <name>`.',
    inputSchema: { username: z.string() },
    annotations: { destructiveHint: true }
  }, async ({ username }) => ok(await p.del('/api/admins/' + q(username))))
}
