// diagnose_* tools — cross-service health + a symptom → knowledge-base router.
// Always registered; each tool works with whatever services the config enables.

import { z } from 'zod'
import { searchDocs } from '../resources/docs.js'

// Curated symptom → KB pointers (the troubleshooting lore that isn't obvious from a
// keyword match). Augmented by a full-text docs_search on the same query.
const SYMPTOMS = [
  { re: /clamp|buffer|\bslow\b|stall|degrad|drop.*packet|rmem|wmem|sysctl|fan.?out/i, kb: 'kb/network-tuning.md', hint: 'swarm UDP socket buffers silently clamped by host sysctls — see server_sysctl' },
  { re: /disk|space|grow|\bfull\b|reclaim|rotat/i, kb: 'kb/feed-buffer.md', hint: 'feed buffer / disk growth + feed rotation' },
  { re: /login|not connected|unreachable|throttle|lockout|429/i, kb: 'kb/operator.md', hint: 'panel/broadcaster operations + the login throttle' },
  { re: /out-of-scope|publisher|register|origin/i, kb: 'security-model.md', hint: 'per-publisher keys + channel scopes (S26): extend the scope before adding channels' },
  { re: /slate|offline|blank|no.?video|source offline/i, kb: 'kb/offline-slate.md', hint: 'a dead source loops the offline slate (still shows ON AIR — check slate.slated)' },
  { re: /scale|capacity|\bcpu\b|ceiling|too many channels/i, kb: 'kb/scaling.md', hint: 'scaling + capacity planning (≈0.04 core/copy-channel)' },
  { re: /corrupt|oplog|epartialread|playback|freeze|crash.*play/i, kb: 'kb/playback.md', hint: 'client playback + store-corruption recovery' },
  { re: /backup|restore|rotation|lost key|recover/i, kb: 'kb/backup-and-rotation.md', hint: 'backup/restore + the key-rotation matrix' },
  { re: /dashboard|caddy|https|expose|public|tls|proxy/i, kb: 'kb/public-dashboards.md', hint: 'publishing the dashboards safely behind Caddy' },
  { re: /source|pull|ingest|codec|hevc|rtmp|srt|udp/i, kb: 'kb/source-compatibility.md', hint: 'pull-ingest source compatibility + codecs' },
  // S49c additions — support lore from the S49a/b cycles:
  { re: /env.*(not|n['’]t|no).*(appl|effect|work|take)|restart.*env|env.*restart|knob|\.env.*ignor/i, kb: 'configuration.md', hint: 'a compose restart does NOT re-read env files — apply env changes via server_set_env (it validates in-image, then recreates with plain up -d)' },
  { re: /renam.*categor|categor.*renam|package.*(lost|empty|missing|strip)|bouquet.*(lost|empty)|selector/i, kb: 'mcp.md', hint: 'a package category:<slug> member is a STRING — renaming/merging the category strips that bouquet\'s holders until the member is edited to the new slug (panel_set_package)' },
  { re: /restore.*(refus|fail|non-empty|not empty)|volume.*not empty/i, kb: 'kb/backup-and-rotation.md', hint: 'server_restore refuses a NON-EMPTY volume or a name-mismatched archive without force:true — with force the current contents are deleted first (untar-over-merge would itself be corruption)' },
  // S50d additions — viewer problem reports + the ops notifier:
  { re: /viewer.?report|problem report|report a problem|reports? (tab|storm|flood|flooding)|complain|no.?audio|black.?screen|wrong content/i, kb: 'reports.md', hint: 'viewer problem reports: triage with panel_list_reports / panel_list_alerts, then panel_ack_report / panel_resolve_report. A storm is COLLAPSED by design (a bounded sample of full records + one extended alert), so "only 20 records for 500 complaints" is the feature, not a loss' },
  { re: /notif|webhook|ntfy|slack|discord|telegram|alert.*(not|n['’]t|never).*(fir|arriv|sen|push)|no alerts?/i, kb: 'reports.md', hint: 'ops notifications are FAIL-DARK: a dead endpoint is retried 3× over ~30 s then DROPPED, and never back-pressures report ingest — so silence can mean unconfigured, dropped, or simply no alert opened. panel_test_notify proves the wiring end to end' }
]

export function registerDiagnoseTools (ctx, h) {
  const { def, ok } = h

  def('diagnose_healthz', {
    title: 'Health sweep',
    description: 'Probe the unauthenticated /healthz of every configured service (panel, broadcaster, reseller, library) and report up/down + each service\'s vitals.',
    annotations: { readOnlyHint: true }
  }, async () => {
    const out = {}
    for (const [name, client] of [['panel', ctx.panel], ['broadcaster', ctx.broadcaster], ['reseller', ctx.reseller], ['library', ctx.library]]) {
      if (!client) { out[name] = { configured: false }; continue }
      try { out[name] = { configured: true, reachable: true, health: await client.healthz() } } catch (err) { out[name] = { configured: true, reachable: false, error: err.message } }
    }
    return ok({ sweep: out })
  })

  def('diagnose_symptom', {
    title: 'Symptom → knowledge base',
    description: 'Map an operator symptom ("playback stalls under load", "disk keeps filling", "channel bounces out-of-scope") to the relevant KB docs. Read the returned resource URIs for the fix.',
    inputSchema: { symptom: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ symptom }) => {
    const curated = []
    for (const s of SYMPTOMS) {
      if (s.re.test(symptom)) {
        const doc = ctx.docsIndex.docs.find((d) => d.relPath === s.kb)
        curated.push({ kb: s.kb, uri: doc ? doc.uri : `mcp://aliran/docs/${s.kb}`, hint: s.hint })
      }
    }
    const search = ctx.docsIndex.docs.length ? searchDocs(ctx.docsIndex, symptom, 5) : []
    return ok({ symptom, curated, search, note: 'read a uri with the resource for the full text' })
  })
}
