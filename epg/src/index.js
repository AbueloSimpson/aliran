// Aliran EPG — standalone program-guide service.
//
//   pluggable ingest (src/ingest.js) -> epoch-rotated public Hyperdrive (src/guide.js)
//     -> announced on the DHT; viewers open a SPARSE replica and fetch only the
//        channel-days they display (the assets-drive pattern)
//     -> drive key advertised via the panel bee's meta/epgKey record, written
//        through the publisher-scoped setEpgKey RPC (src/panel-link.js)
//
// Deliberately a SEPARATE deployable from the panel: guide churn belongs in a
// rotatable drive, not the panel's append-only identity bee; management needs no
// admin services; and the service holds no admin credentials — its publisher key
// (scope `epg`) can write exactly one panel record.

import { config } from './config.js'
import { GuideManager } from './guide.js'
import { IngestScheduler, loadProviders } from './ingest.js'
import { PanelPointerLink } from './panel-link.js'
import { startStatusServer } from './status-server.js'
import { initLogging } from './log.js'

initLogging('epg')

export { GuideManager, canonicalDayJson, utcDay } from './guide.js'
export { IngestScheduler, loadProviders, buildProvider, parseProviderJson, bucketByDay } from './ingest.js'
export { PanelPointerLink } from './panel-link.js'

// Start the whole service (also the test entry — overrides win over env config).
export async function startEpg (overrides = {}) {
  const cfg = { ...config, ...overrides }
  const guide = await new GuideManager(cfg).init()

  const link = new PanelPointerLink(cfg)
  link.connect()
  link.setDesired(guide.driveInfo()) // (re)assert the pointer on every boot — idempotent panel-side
  guide.onRotate = async (info) => link.setDesired(info)

  const providers = cfg.providers || loadProviders(cfg.providersFile)
  const ingest = new IngestScheduler(guide, providers, { refreshHours: cfg.refreshHours })
  ingest.start()

  let status = null
  if (cfg.status.enabled) {
    status = await startStatusServer({ guide, ingest, link }, { host: cfg.status.host, port: cfg.status.port })
    console.log(`Status on http://${status.host}:${status.port}`)
  }

  return {
    guide,
    ingest,
    link,
    status,
    close: async () => {
      ingest.close()
      if (status) { try { await status.close() } catch {} }
      await link.close()
      await guide.close()
    }
  }
}

async function main () {
  const svc = await startEpg()
  const g = svc.guide.status()
  console.log('=== Aliran EPG ===')
  console.log('Epoch     :', g.epoch, `(drive ${String(g.driveKey).slice(0, 8)}…)`)
  console.log('Providers :', svc.ingest.providers.length || 'NONE — nothing will be ingested (create providers.json)')
  console.log('Publisher :', config.publisherName || (config.publisherKey ? '(key set, no name — enroll one)' : 'NOT SET — the panel pointer will not be written'))
  if (!config.panelPubKey) console.log('No PANEL_PUBKEY set — seeding only (no catalog mapping, no pointer).')
  console.log('==================')

  const shutdown = async () => {
    console.log('\nShutting down…')
    await svc.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
