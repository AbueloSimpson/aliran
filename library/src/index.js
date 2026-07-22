// Aliran library — standalone VOD service (S8a).
//
//   title = operator-registered video file (path/URL)
//     -> one-shot ffmpeg ingest to HLS VOD (transcode or -c copy remux)
//     -> imported into an encrypted Hyperdrive (ALL segments kept — no rolling window)
//     -> seeded persistently over ONE Hyperswarm (clients replicate + re-seed)
//     -> registered with the panel as `type:'vod'` + durationSec (publisher-key auth;
//        grants/sealing machinery unchanged — a title is entitled exactly like a channel)
//
// Deliberately a SEPARATE deployable from the broadcaster: none of the live pipeline's
// lifecycle (watchdogs, rolling buffers, feed rotation, boot-resume pacing) applies to
// a static seed, ingest is a transcode burst operators must be able to run on DIFFERENT
// hardware than the live fleet, and the failure domains stay separate.
//
// Titles are managed over the authed HTTP control API (src/control-server.js) when
// CONTROL_ENABLED=1 — which is the only way to add one, so enabling it is the normal
// mode (the service still runs without it, seeding + registering whatever the registry
// already holds).

import { config } from './config.js'
import { TitleManager } from './titles.js'
import { startControlServer } from './control-server.js'
import { loadAdmins } from './control-auth.js'

export { TitleManager } from './titles.js'
export { ControlError } from './titles.js'
export { startControlServer } from './control-server.js'

// Start the whole service (also the test entry — overrides win over env config).
// Resolves to { manager, control, close } once seeding + (optionally) listening.
export async function startLibrary (overrides = {}) {
  const cfg = { ...config, ...overrides }
  const manager = new TitleManager(cfg)
  await manager.init()

  let control = null
  if (cfg.control.enabled) {
    if (Object.keys(loadAdmins(cfg.dataDir)).length === 0) {
      console.warn('Control API enabled but no admins exist — create one: node src/library-cli.js add-admin <name>')
    }
    control = await startControlServer({ config: cfg, manager, dataDir: cfg.dataDir }, {
      host: cfg.control.host,
      port: cfg.control.port,
      sessionTtlMs: cfg.control.sessionTtlHours * 3600000,
      lockout: cfg.lockout
    })
    console.log(`Control API on http://${control.host}:${control.port}`)
  }

  return {
    manager,
    control,
    close: async () => {
      if (control) { try { await control.close() } catch {} }
      await manager.close()
    }
  }
}

async function main () {
  const lib = await startLibrary()
  const h = lib.manager.health()
  console.log('=== Aliran library ===')
  console.log('Titles    :', h.titles, `(${h.ready} ready, ${h.error} error)`)
  console.log('Publisher :', config.publisherName || (config.publisherKey ? '(legacy shared key)' : 'NOT SET — titles will not register'))
  if (!config.panelPubKey) console.log('No PANEL_PUBKEY set — seeding only (titles will not appear in any catalog).')
  console.log('======================')
  console.log('Seeding on the DHT…')

  const shutdown = async () => {
    console.log('\nShutting down…')
    await lib.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
