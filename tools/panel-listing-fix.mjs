#!/usr/bin/env node
// Panel listing repair, 2026-08-18. TWO independent steps, both DRY-RUN unless --apply.
//
//   --enable-redirects  re-stamp isLive:true on every SOURCE-OWNED redirect channel the
//                       liveness probe dimmed. Those channels were never the probe's to
//                       judge — their own daily GitHub rebuild is the authority, while the
//                       panel probes from ONE datacenter address that the FAST platforms
//                       refuse (all 248 Pluto channels were flagged offline; they serve
//                       fine to viewers). Scoping the probe (LIVENESS_SCOPE=events) stops
//                       NEW verdicts but does not revisit stored flags — this is that repair.
//
//   --purge-xyz         export, then DELETE, the manual channels on the dead provider
//                       247v2.xyzstreams.st. IRREVERSIBLE: catalog record, stream secret,
//                       every user's grant and the art all go. The export written first is
//                       what the rework is rebuilt from, so the delete refuses without it.
//
// Both steps re-derive their target set from the LIVE panel, never from a stale snapshot.
//
// RUNNING IT ON THE PANEL BOX, which is where it normally belongs. The admin API binds
// 127.0.0.1 and the panel runs `network_mode: host`, so the port is on the host's own
// loopback — but the host has no node, and `tools/` is not copied into the panel image
// (panel/Dockerfile takes only core/, panel/src and panel/admin-ui). So mount the checkout
// into a throwaway node container that shares the host network:
//
//   cd /opt/aliran && git pull
//   docker run --rm -it --network host -v /opt/aliran:/repo -w /repo node:24-bookworm-slim \
//     node tools/panel-listing-fix.mjs --url http://127.0.0.1:3210 --user admin --enable-redirects
//
// Add --apply once the dry run reads right. The password is prompted for; export
// PANEL_ADMIN_PASS instead only if you are comfortable with it in the shell history.
//
// Off-box (an admin URL you can actually reach), PowerShell 5.1 — no && chaining:
//   node panel-listing-fix.mjs --url https://panel.example:8443 --user admin --enable-redirects

import fs from 'fs'
import path from 'path'
import readline from 'readline'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const BASE = (opt('--url') || process.env.PANEL_ADMIN_URL || '').replace(/\/+$/, '')
const USER = opt('--user') || process.env.PANEL_ADMIN_USER || 'admin'
const APPLY = flag('--apply')
const DO_ENABLE = flag('--enable-redirects')
const DO_PURGE = flag('--purge-xyz')
const XYZ_HOST = '247v2.xyzstreams.st'
// A ceiling, not a target: if the selection ever comes back wildly larger than the 358
// measured on 2026-08-18, something in the predicate has drifted, and a blind mass write is
// the last thing that should happen then. Raise it deliberately, never reflexively.
const ENABLE_CEILING = 800

if (!BASE || (!DO_ENABLE && !DO_PURGE)) {
  console.error('usage: node panel-listing-fix.mjs --url <admin-api-url> [--user admin] (--enable-redirects | --purge-xyz) [--apply]')
  process.exit(2)
}

async function prompt (q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try { return await new Promise((r) => rl.question(q, r)) } finally { rl.close() }
}

async function api (method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (!res.ok) throw new Error(method + ' ' + p + ' -> HTTP ' + res.status + ' ' + text.slice(0, 200))
  return json
}

const pass = process.env.PANEL_ADMIN_PASS || await prompt('password for ' + USER + ': ')
const { token } = await api('POST', '/api/login', { username: USER, password: pass })
console.log('authenticated as ' + USER + ' at ' + BASE + '\n')

const all = await api('GET', '/api/streams', null, token)
const streams = Array.isArray(all) ? all : (all.streams || [])
console.log('catalog: ' + streams.length + ' records, ' + streams.filter((c) => c.isLive === false).length + ' currently marked offline\n')

// ---------------------------------------------------------------- step 1: enable
if (DO_ENABLE) {
  // SOURCE-OWNED redirect channels only. `c.source` is the whole guard, and it excludes two
  // populations on purpose: the MANUAL channels (nothing rebuilds those, so what owns their
  // flag is a separate question), and the P2P records, whose isLive comes from the
  // broadcaster heartbeat and is TRUE information — re-stamping a channel that genuinely is
  // not publishing would replace a fact with a lie.
  const targets = streams.filter((c) =>
    c.redirect === true && !c.feedKey && c.type !== 'vod' && c.isLive === false && c.source)

  const bySource = {}
  for (const c of targets) bySource[c.source] = (bySource[c.source] || 0) + 1
  console.log('[enable] ' + targets.length + ' source-owned redirect channels are dimmed:')
  for (const [s, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log('           ' + String(n).padStart(4) + '  ' + s)
  }

  if (targets.length > ENABLE_CEILING) {
    console.error('\n[enable] REFUSING: ' + targets.length + ' exceeds the ' + ENABLE_CEILING + ' sanity ceiling. Re-read the predicate before raising it.')
    process.exit(1)
  }
  if (!APPLY) {
    console.log('\n[enable] DRY RUN — nothing written. Re-run with --apply to re-stamp these isLive:true.')
  } else {
    let ok = 0
    const failed = []
    for (const c of targets) {
      // One field, deliberately: ops.js reaches its url/status block only when `url` or
      // `redirect` is present in the patch, so a bare isLive edit disturbs nothing else.
      try {
        await api('PATCH', '/api/streams/' + encodeURIComponent(c.id), { isLive: true }, token)
        ok++
        if (ok % 50 === 0) console.log('           …' + ok + '/' + targets.length)
      } catch (err) { failed.push([c.id, err.message]) }
    }
    console.log('\n[enable] re-stamped ' + ok + '/' + targets.length + ' isLive:true')
    for (const [id, m] of failed) console.log('           FAILED ' + id + ': ' + m)
  }
}

// ---------------------------------------------------------------- step 2: purge
if (DO_PURGE) {
  const host = (u) => { try { return new URL(u).host } catch { return '' } }
  const targets = streams.filter((c) => c.url && host(c.url) === XYZ_HOST)
  // The delete is a full purge, so the predicate is CHECKED rather than trusted: anything
  // carrying a feedKey or a source name is not a hand-added channel on this provider and has
  // no business in this batch.
  const wrong = targets.filter((c) => c.feedKey || c.source)
  console.log('\n[purge] ' + targets.length + ' manual channels on ' + XYZ_HOST)
  if (wrong.length) {
    console.error('[purge] REFUSING: ' + wrong.length + ' candidate(s) carry a feedKey or a source — not hand-added channels: ' + wrong.slice(0, 5).map((c) => c.id).join(', '))
    process.exit(1)
  }
  if (!targets.length) { console.log('[purge] nothing to do'); process.exit(0) }

  // Export BEFORE anything is destroyed, and make the export the precondition — a purge with
  // no manifest is the one outcome that cannot be undone or reworked from.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = path.join(process.cwd(), 'xyzstreams-backup-' + stamp + '.json')
  fs.writeFileSync(out, JSON.stringify(targets, null, 2))
  const size = fs.statSync(out).size
  if (!size) { console.error('[purge] REFUSING: the export is empty'); process.exit(1) }
  console.log('[purge] exported ' + targets.length + ' full records -> ' + out + ' (' + (size / 1024).toFixed(1) + ' KB)')

  if (!APPLY) {
    console.log('[purge] DRY RUN — nothing deleted. The export above is already written; re-run with --apply to purge.')
  } else {
    // ONE batch call, never a loop over DELETE /api/streams/:id. A user record embeds a
    // sealed grant per channel in a single json value, so the per-id route re-serialises
    // every entitled user's whole ~455 KB record PER CHANNEL: 90 ids x 12 holders is
    // ~490 MB of permanent append-only growth on a store that compacts to single-digit MB.
    // The batch route makes one pass over the users for the whole set.
    const result = await api('DELETE', '/api/streams', { ids: targets.map((c) => c.id) }, token)
    console.log('[purge] deleted ' + result.ok.length + '/' + targets.length + ' channels (catalog + secret + grants + art)')
    for (const f of result.failed || []) console.log('         FAILED ' + f.id + ': ' + f.error)
    if (result.rollbackSnapshot) console.log('[purge] rollback snapshot: ' + JSON.stringify(result.rollbackSnapshot))
    console.log('[purge] rework rebuilds from ' + out)
  }
}
