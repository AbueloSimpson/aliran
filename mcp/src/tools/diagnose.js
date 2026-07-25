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
  { re: /source|pull|ingest|codec|hevc|rtmp|srt|udp/i, kb: 'kb/source-compatibility.md', hint: 'pull-ingest source compatibility + codecs' }
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
