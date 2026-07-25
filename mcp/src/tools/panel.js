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
    description: 'List viewer accounts (prefix search + cursor paging). Returns {users,next}.',
    inputSchema: { prefix: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true }
  }, async ({ prefix, after, limit }) => {
    const qs = []
    if (prefix) qs.push('prefix=' + q(prefix))
    if (after) qs.push('after=' + q(after))
    if (limit) qs.push('limit=' + q(limit))
    return ok(await p.get('/api/users' + (qs.length ? '?' + qs.join('&') : '')))
  })

  def('panel_get_user', { title: 'Get user', description: 'One viewer account: grants, packages, manualGrants, devices, status.', inputSchema: { username: z.string() }, annotations: { readOnlyHint: true } },
    async ({ username }) => ok(await p.get('/api/users/' + q(username))))

  def('panel_list_devices', { title: 'List a user\'s devices', description: 'Enrolled devices for a viewer account.', inputSchema: { username: z.string() }, annotations: { readOnlyHint: true } },
    async ({ username }) => ok(await p.get('/api/users/' + q(username) + '/devices')))

  def('panel_list_streams', { title: 'List streams', description: 'Full channel catalog (P2P + redirect channels).', annotations: { readOnlyHint: true } },
    async () => ok(await p.get('/api/streams')))

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
    description: 'Create a viewer account. If password is omitted a strong one is generated and returned so you can hand it to the viewer. Default packages + source auto-grants are applied automatically.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional() }
  }, async ({ username, password }) => {
    const pw = password || genPassword()
    const out = await p.post('/api/users', { username, password: pw })
    return ok({ ...out, generatedPassword: password ? undefined : pw })
  })

  def('panel_set_user_password', {
    title: 'Set a user password',
    description: 'Reset a viewer account password (re-seals grants). Omit password to generate + return a strong one.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional() }
  }, async ({ username, password }) => {
    const pw = password || genPassword()
    const out = await p.post('/api/users/' + q(username) + '/password', { password: pw })
    return ok({ ...out, generatedPassword: password ? undefined : pw })
  })

  def('panel_set_user_status', { title: 'Enable/disable a user', description: 'Set a viewer account active or disabled (disable revokes live sessions).', inputSchema: { username: z.string(), status: z.enum(['active', 'disabled']) } },
    async ({ username, status }) => ok(await p.post('/api/users/' + q(username) + '/status', { status })))

  def('panel_set_max_devices', { title: 'Set max devices', description: 'Set the concurrent-device limit for a viewer account.', inputSchema: { username: z.string(), maxDevices: z.number().int().min(1) } },
    async ({ username, maxDevices }) => ok(await p.post('/api/users/' + q(username) + '/max-devices', { maxDevices })))

  def('panel_logout_all', { title: 'Log out all devices', description: 'Revoke every session for a viewer account (tokenVersion bump).', inputSchema: { username: z.string() } },
    async ({ username }) => ok(await p.post('/api/users/' + q(username) + '/logout-all', {})))

  def('panel_grant', { title: 'Grant a stream', description: 'Grant a viewer account a single stream (adds a manual entitlement, sealed to the user key).', inputSchema: { username: z.string(), streamId: z.string() } },
    async ({ username, streamId }) => ok(await p.post('/api/users/' + q(username) + '/grants', { streamId })))

  def('panel_set_user_packages', { title: 'Set a user\'s packages', description: 'Replace the viewer\'s package list (bouquets); grants materialize immediately.', inputSchema: { username: z.string(), packages: z.array(z.string()) } },
    async ({ username, packages }) => ok(await p.post('/api/users/' + q(username) + '/packages', { packages })))

  // ---- streams / packages / sources: create / mutate ----
  def('panel_add_stream', {
    title: 'Add a stream',
    description: 'Add a channel. Provide `url` (https) for a REDIRECT channel (viewers play the url, no P2P feed); otherwise a P2P channel a broadcaster will register a feed for.',
    inputSchema: { id: z.string(), title: z.string().optional(), description: z.string().optional(), category: z.union([z.string(), z.array(z.string())]).optional(), url: z.string().optional(), order: z.number().int().optional(), featured: z.boolean().optional() }
  }, async (a) => ok(await p.post('/api/streams', a)))

  def('panel_set_stream_meta', {
    title: 'Edit a stream',
    description: 'Patch channel metadata (title/description/category/order/featured/isLive/status/url).',
    inputSchema: { id: z.string(), title: z.string().optional(), description: z.string().optional(), category: z.union([z.string(), z.array(z.string())]).optional(), url: z.string().optional(), isLive: z.boolean().optional(), status: z.string().optional(), order: z.number().int().nullable().optional(), featured: z.boolean().optional() }
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
    description: 'Enroll a broadcaster identity (per-site key + channel scopes). The secret key is NEVER returned to you: it is written into the box broadcaster .env when SSH is configured, otherwise withheld.',
    inputSchema: { name: z.string(), scopes: z.array(z.string()).optional() }
  }, async ({ name, scopes }) => {
    const out = await p.post('/api/publishers', { name, scopes })
    const { secretKey, ...safe } = out
    let secretDisposition
    if (ctx.ssh && ctx.ssh.configured && secretKey) {
      try {
        const envPath = `${ctx.config.install.repoDir}/broadcaster/.env`
        await ctx.upsertEnv(envPath, { PUBLISHER_NAME: name, PUBLISHER_KEY: secretKey })
        secretDisposition = `written to ${envPath} on ${ctx.ssh.host} (restart the broadcaster to apply)`
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

  def('panel_revoke_grant', { title: 'Revoke a grant', description: 'Remove a viewer\'s MANUAL entitlement for a stream (a package that still covers it re-seals it).', inputSchema: { username: z.string(), streamId: z.string() }, annotations: { destructiveHint: true } },
    async ({ username, streamId }) => ok(await p.del('/api/users/' + q(username) + '/grants/' + q(streamId))))

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
